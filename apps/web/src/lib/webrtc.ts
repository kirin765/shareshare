import { LOW_WATER_BYTES } from "./channel-transport.js";

export type ConnectionPath = "direct" | "relay" | null;

export interface SignalOut {
  type: "offer" | "answer" | "ice-candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
}

export interface PeerCallbacks {
  onChannel: (channel: RTCDataChannel) => void;
  onData: (data: string | ArrayBuffer) => void;
  onChannelClosed: () => void;
  onState: (state: RTCPeerConnectionState) => void;
  onPath: (path: ConnectionPath) => void;
  onError: (error: Error) => void;
}

export interface PeerOptions {
  role: "sender" | "receiver";
  iceServers: RTCIceServer[];
  forceRelay?: boolean;
  sendSignal: (message: SignalOut) => void;
  callbacks: PeerCallbacks;
}

/**
 * Thin wrapper around RTCPeerConnection. The sender is always the offerer and
 * owns the data channel; the receiver answers and adopts the incoming channel.
 */
export class PeerLink {
  readonly #role: "sender" | "receiver";
  readonly #iceServers: RTCIceServer[];
  readonly #forceRelay: boolean;
  readonly #sendSignal: (message: SignalOut) => void;
  readonly #callbacks: PeerCallbacks;

  #pc: RTCPeerConnection | null = null;
  #channel: RTCDataChannel | null = null;
  #remoteReady = false;
  #pendingCandidates: RTCIceCandidateInit[] = [];
  #closed = false;
  #pathTimer: number | null = null;
  #negotiating = false;

  constructor(options: PeerOptions) {
    this.#role = options.role;
    this.#iceServers = options.iceServers;
    this.#forceRelay = options.forceRelay ?? false;
    this.#sendSignal = options.sendSignal;
    this.#callbacks = options.callbacks;
  }

  get channel(): RTCDataChannel | null {
    return this.#channel;
  }

  get pc(): RTCPeerConnection | null {
    return this.#pc;
  }

  get isChannelOpen(): boolean {
    return this.#channel?.readyState === "open";
  }

  get connectionState(): RTCPeerConnectionState | "none" {
    return this.#pc?.connectionState ?? "none";
  }

  updateIceServers(servers: RTCIceServer[]): void {
    this.#iceServers.splice(0, this.#iceServers.length, ...servers);
  }

  async startOffer(options: { iceRestart?: boolean; forceNew?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    if (this.#negotiating) return;
    const unusable =
      !this.#pc ||
      this.#pc.signalingState === "closed" ||
      this.#pc.connectionState === "failed" ||
      this.#pc.connectionState === "closed" ||
      this.#pc.signalingState !== "stable";

    if (options.forceNew || unusable) {
      this.#createPc(true);
    }
    const pc = this.#pc;
    if (!pc) return;

    // The PC can survive while the data channel is closed. Recreate the
    // channel on the existing connection so resume has a transport again.
    if (this.#role === "sender" && (!this.#channel || this.#channel.readyState === "closed")) {
      this.#setupChannel(pc.createDataChannel("shareshare-file", { ordered: true }));
    }

    this.#negotiating = true;
    try {
      const offer = await pc.createOffer({
        iceRestart: options.iceRestart === true && pc.signalingState === "stable",
      });
      await pc.setLocalDescription(offer);
      if (!pc.localDescription?.sdp) throw new Error("local offer missing");
      this.#sendSignal({ type: "offer", sdp: pc.localDescription.sdp });
    } catch (error) {
      this.#callbacks.onError(error instanceof Error ? error : new Error("offer failed"));
    } finally {
      this.#negotiating = false;
    }
  }

  async handleOffer(sdp: string): Promise<void> {
    if (this.#closed) return;
    if (this.#negotiating) return;
    const unusable =
      !this.#pc ||
      this.#pc.signalingState === "closed" ||
      this.#pc.connectionState === "failed" ||
      this.#pc.connectionState === "closed" ||
      this.#pc.signalingState === "have-local-offer";
    if (unusable) this.#createPc(false);
    const pc = this.#pc;
    if (!pc) return;

    this.#negotiating = true;
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      this.#remoteReady = true;
      await this.#flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!pc.localDescription?.sdp) throw new Error("local answer missing");
      this.#sendSignal({ type: "answer", sdp: pc.localDescription.sdp });
    } catch (error) {
      this.#callbacks.onError(error instanceof Error ? error : new Error("answer failed"));
    } finally {
      this.#negotiating = false;
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (this.#closed || !this.#pc) return;
    if (this.#pc.signalingState !== "have-local-offer") return;
    try {
      await this.#pc.setRemoteDescription({ type: "answer", sdp });
      this.#remoteReady = true;
      await this.#flushCandidates();
    } catch (error) {
      this.#callbacks.onError(error instanceof Error ? error : new Error("answer handling failed"));
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (!this.#pc || !this.#remoteReady || !this.#pc.remoteDescription) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch {
      // Candidates can race a renegotiation; the next offer re-establishes them.
    }
  }

  /** Drop the current connection; the next offer recreates it. */
  reset(): void {
    this.#teardown();
    this.#remoteReady = false;
    this.#pendingCandidates = [];
  }

  close(): void {
    this.#closed = true;
    this.#teardown();
  }

  #createPc(offerer: boolean): void {
    this.#teardown();
    const pc = new RTCPeerConnection({
      iceServers: this.#iceServers,
      iceTransportPolicy: this.#forceRelay ? "relay" : "all",
      bundlePolicy: "max-bundle",
    });
    this.#pc = pc;
    this.#remoteReady = false;
    this.#pendingCandidates = [];

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal({ type: "ice-candidate", candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      this.#callbacks.onState(pc.connectionState);
      if (pc.connectionState === "connected") this.#startPathPolling();
      else if (pc.connectionState !== "connecting") this.#stopPathPolling();
    };
    pc.oniceconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      if (pc.iceConnectionState === "failed") {
        this.#callbacks.onState("failed");
      } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.#callbacks.onState(pc.connectionState);
        void this.#detectPath();
      }
    };
    pc.ondatachannel = (event) => {
      if (this.#pc !== pc) return;
      this.#setupChannel(event.channel);
    };
    pc.onicecandidateerror = () => {
      // Non-fatal: ICE may still succeed through another candidate pair.
    };

    if (offerer) {
      const channel = pc.createDataChannel("shareshare-file", { ordered: true });
      this.#setupChannel(channel);
    }
  }

  #setupChannel(channel: RTCDataChannel): void {
    this.#channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    const queued: Array<string | ArrayBuffer> = [];
    let ready = false;
    channel.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (ready) this.#callbacks.onData(event.data);
      else queued.push(event.data);
    };
    channel.onopen = () => {
      if (this.#channel !== channel) return;
      try {
        this.#callbacks.onChannel(channel);
      } catch (error) {
        this.#callbacks.onError(
          error instanceof Error ? error : new Error("data channel setup failed"),
        );
        return;
      }
      ready = true;
      for (const data of queued.splice(0)) this.#callbacks.onData(data);
    };
    channel.onclose = () => {
      if (this.#channel !== channel) return;
      this.#callbacks.onChannelClosed();
    };
    channel.onerror = () => {
      if (this.#channel !== channel) return;
      this.#callbacks.onError(new Error("data channel error"));
    };
  }

  async #flushCandidates(): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    const candidates = this.#pendingCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignored; a new offer will retry connectivity */
      }
    }
  }

  #startPathPolling(): void {
    this.#stopPathPolling();
    void this.#detectPath();
    this.#pathTimer = window.setInterval(() => void this.#detectPath(), 3000);
  }

  #stopPathPolling(): void {
    if (this.#pathTimer !== null) {
      window.clearInterval(this.#pathTimer);
      this.#pathTimer = null;
    }
  }

  async #detectPath(): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    try {
      const report = await pc.getStats();
      const stats = new Map<string, Record<string, unknown>>();
      report.forEach((entry) => {
        stats.set(entry.id, entry as unknown as Record<string, unknown>);
      });
      let pair: Record<string, unknown> | undefined;
      for (const entry of stats.values()) {
        if (
          entry.type === "candidate-pair" &&
          entry.state === "succeeded" &&
          (entry.nominated === true || entry.selected === true)
        ) {
          pair = entry;
          break;
        }
      }
      if (!pair) {
        for (const entry of stats.values()) {
          if (entry.type === "candidate-pair" && entry.state === "succeeded") {
            pair = entry;
            break;
          }
        }
      }
      if (!pair) return;
      const local = stats.get(String(pair.localCandidateId));
      const remote = stats.get(String(pair.remoteCandidateId));
      const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
      this.#callbacks.onPath(relay ? "relay" : "direct");
    } catch {
      /* stats are advisory */
    }
  }

  #teardown(): void {
    this.#stopPathPolling();
    const channel = this.#channel;
    this.#channel = null;
    if (channel) {
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      try {
        channel.close();
      } catch {
        /* already closed */
      }
    }
    const pc = this.#pc;
    this.#pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
  }
}
