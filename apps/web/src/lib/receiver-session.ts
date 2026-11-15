import { parseDataMessage, parseJson, type SignalingServerMessage } from "@shareshare/protocol";
import {
  Receiver,
  type ReceiverEvent,
  type TransferState,
} from "@shareshare/transfer";
import { ChannelTransport } from "./channel-transport.js";
import { WritableSink, openWritable, pickSaveHandle } from "./fs.js";
import { createWorkerHasherFactory, type WorkerHasherFactory } from "./hasher.js";
import {
  SignalingRoom,
  describeRoomError,
  toRtcIceServers,
  type RoomEvent,
} from "./signaling-room.js";
import { PeerLink, type ConnectionPath, type SignalOut } from "./webrtc.js";

const FORCE_RELAY = (import.meta.env.VITE_FORCE_RELAY as string | undefined) === "true";

export type ReceiverPhase =
  | "joining"
  | "awaiting-approval"
  | "negotiating"
  | "awaiting-offer"
  | "offer"
  | "transferring"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "reconnecting";

export interface ReceiverState {
  phase: ReceiverPhase;
  fileName: string | null;
  fileSize: bigint | null;
  mime: string | null;
  savedName: string | null;
  connectionCode: string | null;
  progress: {
    done: bigint;
    total: bigint;
    bytesPerSecond: number;
    etaMs: number | null;
  };
  path: ConnectionPath;
  error: { code: string; message: string } | null;
  notice: string | null;
  sha256: string | null;
  partialBytes: bigint | null;
  canChooseDestination: boolean;
  reconnectAttempt: number;
  startedAt: number;
  finishedAt: number | null;
}

interface ReceiverSessionOptions {
  url: string;
  transferId: string;
  roomId: string;
  inviteToken: string;
  onState: (state: ReceiverState) => void;
}


export class ReceiverSession {
  #state: ReceiverState;
  #onState: (state: ReceiverState) => void;
  #url: string;
  #roomId: string;
  #inviteToken: string;
  #transferId: string;
  #room: SignalingRoom | null = null;
  #peer: PeerLink | null = null;
  #receiver: Receiver | null = null;
  #transport: ChannelTransport | null = null;
  #sink: WritableSink | null = null;
  #factory: WorkerHasherFactory = createWorkerHasherFactory();
  #iceServers: RTCIceServer[] = [];
  #approved = false;
  #terminal = false;
  #cleaned = false;
  #transportClosed = false;
  #signalingOnline = true;
  #resumeInFlight = false;
  #everConnected = false;
  #wasDisconnected = false;
  #picking = false;
  #graceTimer: number | null = null;
  #beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.#state.phase !== "transferring" && this.#state.phase !== "verifying") return;
    event.preventDefault();
    event.returnValue = "";
  };

  constructor(options: ReceiverSessionOptions) {
    this.#url = options.url;
    this.#roomId = options.roomId;
    this.#inviteToken = options.inviteToken;
    this.#transferId = options.transferId;
    this.#onState = options.onState;
    this.#state = {
      phase: "joining",
      fileName: null,
      fileSize: null,
      mime: null,
      savedName: null,
      connectionCode: null,
      progress: {
        done: 0n,
        total: 0n,
        bytesPerSecond: 0,
        etaMs: null,
      },
      path: null,
      error: null,
      notice: null,
      sha256: null,
      partialBytes: null,
      canChooseDestination: false,
      reconnectAttempt: 0,
      startedAt: 0,
      finishedAt: null,
    };
    window.addEventListener("beforeunload", this.#beforeUnload);
  }

  get state(): ReceiverState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#room = new SignalingRoom({
      url: this.#url,
      transferId: this.#transferId,
      onEvent: (event) => this.#onRoomEvent(event),
    });
    try {
      const joined = await this.#room.joinRoom(this.#roomId, this.#inviteToken);
      this.#iceServers = toRtcIceServers(joined.iceServers);
      this.#patch({
        phase: "awaiting-approval",
        connectionCode: joined.connectionCode,
        notice:
          "송신자에게 연결 확인 코드를 확인받아야 합니다. 승인되면 자동으로 연결을 설정합니다.",
      });
    } catch (error) {
      this.#failFrom(error);
    }
  }

  chooseDestination(): void {
    if (this.#terminal || this.#picking) return;
    if (!this.#state.fileName || !this.#receiver) {
      this.#patch({ notice: "파일 정보를 기다리는 중입니다." });
      return;
    }
    if (this.#receiver.state !== "awaiting-accept") {
      this.#patch({ notice: "아직 저장 위치를 선택할 수 없습니다." });
      return;
    }
    this.#picking = true;
    void (async () => {
      let sink: WritableSink | null = null;
      try {
        const handle = await pickSaveHandle(this.#state.fileName!);
        sink = await openWritable(handle);
        if (this.#terminal || !this.#receiver || this.#receiver.state !== "awaiting-accept") {
          await sink.abort("state changed");
          return;
        }
        this.#sink = sink;
        this.#receiver.accept(sink);
        this.#patch({
          phase: "transferring",
          savedName: handle.name,
          canChooseDestination: false,
          notice: null,
          startedAt: Date.now(),
        });
      } catch (error) {
        if (sink) {
          try {
            await sink.abort("picker failed");
          } catch {
            /* ignore */
          }
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          this.#patch({ notice: "저장 위치 선택이 취소되었습니다. 다시 선택할 수 있습니다." });
          return;
        }
        this.#patch({
          notice:
            error instanceof Error
              ? `저장 위치를 열 수 없습니다: ${error.message}`
              : "저장 위치를 열 수 없습니다.",
        });
      } finally {
        this.#picking = false;
      }
    })();
  }

  cancel(): void {
    if (this.#terminal) return;
    const room = this.#room;
    this.#room = null;
    room?.leave();
    this.#terminal = true;
    if (this.#receiver) {
      void this.#receiver.cancel("USER_CANCELLED", "수신자가 전송을 취소했습니다.");
    }
    this.#patch({ phase: "cancelled", notice: "전송을 취소했습니다." });
    this.#cleanup();
  }

  close(): void {
    if (this.#terminal) {
      this.#cleanup();
      return;
    }
    const room = this.#room;
    this.#room = null;
    room?.leave();
    this.#terminal = true;
    if (this.#receiver) {
      void this.#receiver.cancel("PAGE_CLOSED", "수신자 페이지가 닫혔습니다.");
    }
    this.#cleanup();
  }

  #onRoomEvent(event: RoomEvent): void {
    if (this.#cleaned || this.#terminal) return;
    if (event.type === "fatal") {
      this.#fail(event.code, describeRoomError(event.code));
      return;
    }
    if (event.type === "status") {
      if (event.status === "reconnecting") {
        this.#signalingOnline = false;
        this.#patch({
          notice: this.#peer?.isChannelOpen
            ? "시그널링 서버 연결이 끊겨 재연결을 시도합니다. 데이터 전송은 계속됩니다."
            : "시그널링 서버 연결이 끊겨 재연결을 시도합니다.",
          ...(this.#isTransferActive() && !this.#peer?.isChannelOpen
            ? { phase: "reconnecting" as const }
            : {}),
        });
      } else if (event.status === "connected") {
        this.#signalingOnline = true;
        const receiverState = this.#receiver?.state;
        this.#patch({
          notice: null,
          ...(receiverState === "transferring" && this.#state.phase === "reconnecting"
            ? { phase: "transferring" as const }
            : {}),
        });
      } else if (event.status === "closed" && !this.#terminal) {
        this.#fail("SIGNALING_DISCONNECTED", describeRoomError("SIGNALING_DISCONNECTED"));
      }
      return;
    }
    this.#onMessage(event.message);
  }

  #onMessage(message: SignalingServerMessage): void {
    if (this.#terminal) return;
    switch (message.type) {
      case "joined":
      case "room-created":
        return;
      case "peer-approved":
        this.#approved = true;
        this.#patch({
          phase: "negotiating",
          notice: "송신자가 연결을 승인했습니다. 연결을 설정하는 중입니다.",
        });
        this.#ensurePeer();
        return;
      case "offer":
        this.#ensurePeer();
        if (this.#peer) void this.#peer.handleOffer(message.sdp);
        return;
      case "answer":
        return;
      case "ice-candidate":
        void this.#peer?.addIceCandidate(message.candidate);
        return;
      case "peer-left":
        if (message.role !== "sender") return;
        if (message.final) {
          this.#fail("PEER_LEFT", "송신자가 연결을 종료했습니다.");
        } else if (this.#isTransferActive()) {
          this.#patch({
            phase: this.#peer?.isChannelOpen ? this.#state.phase : "reconnecting",
            notice: this.#peer?.isChannelOpen
              ? "송신자의 시그널링이 재연결되는 중입니다. 데이터 전송은 계속됩니다."
              : "송신자 연결이 끊겼습니다. 재연결을 기다립니다.",
          });
        } else {
          this.#patch({ notice: "송신자 연결이 잠시 끊겼습니다. 재연결을 기다립니다." });
        }
        return;
      case "peer-reconnected":
        if (message.role !== "sender" || !this.#approved) return;
        if (this.#peer?.isChannelOpen) {
          this.#patch({
            phase: this.#receiver?.state === "transferring" ? "transferring" : this.#state.phase,
            notice: "송신자가 재연결했습니다. 데이터 전송은 계속됩니다.",
          });
        } else {
          this.#patch({
            phase: "negotiating",
            notice: "송신자가 재연결했습니다. 연결을 복구하는 중입니다.",
          });
          this.#ensurePeer();
        }
        return;
      case "resumed":
        this.#signalingOnline = true;
        this.#iceServers = toRtcIceServers(message.iceServers);
        this.#peer?.updateIceServers(this.#iceServers);
        if (message.approved) {
          this.#approved = true;
          const receiverState = this.#receiver?.state;
          this.#patch({
            phase:
              this.#peer?.isChannelOpen && receiverState === "transferring"
                ? "transferring"
                : this.#peer?.isChannelOpen
                  ? this.#state.phase
                  : "negotiating",
            notice:
              this.#peer?.isChannelOpen && this.#isTransferActive()
                ? null
                : "시그널링 연결이 복구되었습니다. 연결을 복구하는 중입니다.",
          });
          this.#ensurePeer();
        } else {
          this.#patch({ phase: "awaiting-approval", notice: "시그널링 연결이 복구되었습니다." });
        }
        return;
      case "error":
        if (
          message.code === "RATE_LIMITED" ||
          message.code === "SESSION_DISCONNECTED" ||
          message.code === "SERVER_BUSY"
        ) {
          this.#patch({ notice: describeRoomError(message.code) });
          return;
        }
        this.#fail(message.code, message.message ?? describeRoomError(message.code));
        return;
      case "room-expired":
        this.#fail("ROOM_EXPIRED", describeRoomError("ROOM_EXPIRED"));
        return;
      default:
        return;
    }
  }

  #ensurePeer(): void {
    if (this.#terminal || this.#peer) return;
    this.#peer = new PeerLink({
      role: "receiver",
      iceServers: this.#iceServers,
      forceRelay: FORCE_RELAY,
      sendSignal: (message) => this.#sendSignal(message),
      callbacks: {
        onChannel: (channel) => this.#onChannel(channel),
        onData: (data) => this.#onData(data),
        onChannelClosed: () => this.#onChannelClosed(),
        onState: (state) => this.#onPeerState(state),
        onPath: (path) => this.#patch({ path }),
        onError: (error) => this.#patch({ notice: error.message }),
      },
    });
  }

  #sendSignal(message: SignalOut): void {
    if (!this.#room) return;
    try {
      this.#room.send(message as unknown as Record<string, unknown> & { type: string });
    } catch {
      /* reconnect will renegotiate */
    }
  }

  #onChannel(channel: RTCDataChannel): void {
    if (this.#terminal || this.#cleaned) return;
    this.#transport = new ChannelTransport(channel);
    if (!this.#receiver) {
      this.#receiver = new Receiver({
        transferId: this.#transferId,
        transport: this.#transport,
        hasherFactory: () => this.#factory.create(),
        onEvent: (event) => this.#onReceiverEvent(event),
      });
    } else {
      this.#receiver.setTransport(this.#transport);
    }
    this.#receiver.channelOpen();
    this.#resumeInFlight = false;

    if (!this.#state.fileName) {
      this.#patch({ phase: "awaiting-offer", notice: "파일 정보를 기다리는 중입니다." });
    } else if (this.#receiver.state === "awaiting-accept") {
      this.#patch({
        phase: "offer",
        canChooseDestination: true,
        notice: "파일 정보를 확인하고 저장 위치를 선택하세요.",
      });
    }
    if (this.#receiver.state === "transferring" || this.#receiver.state === "reconnecting") {
      this.#maybeResume();
    }
  }

  #onData(data: string | ArrayBuffer): void {
    if (!this.#receiver) return;
    if (typeof data === "string") {
      const json = parseJson(data);
      if (json === null) {
        this.#fail("PROTOCOL_ERROR", "올바르지 않은 제어 메시지를 받았습니다.");
        return;
      }
      try {
        this.#receiver.handleControl(parseDataMessage(json));
      } catch {
        this.#fail("PROTOCOL_ERROR", "제어 메시지 형식이 올바르지 않습니다.");
      }
      return;
    }
    this.#receiver.handleFrame(data);
  }

  #onChannelClosed(): void {
    if (this.#terminal) return;
    if (this.#isTransferActive()) {
      this.#patch({
        phase: "reconnecting",
        notice: "데이터 연결이 끊겼습니다. 재연결을 기다립니다.",
      });
    }
  }

  #onPeerState(state: RTCPeerConnectionState): void {
    if (this.#terminal) return;
    if (state === "connected") {
      this.#everConnected = true;
      if (this.#wasDisconnected) {
        this.#wasDisconnected = false;
        if (this.#peer?.isChannelOpen) this.#maybeResume();
      }
      if (this.#isTransferActive()) {
        const receiverState = this.#receiver?.state;
        if (receiverState === "transferring") this.#patch({ phase: "transferring" });
        if (receiverState === "reconnecting") this.#patch({ phase: "reconnecting" });
      }
      return;
    }
    if (state === "disconnected" || state === "failed" || state === "closed") {
      this.#wasDisconnected = true;
      if (this.#isTransferActive()) {
        this.#patch({
          phase: "reconnecting",
          notice: "네트워크 연결이 끊겼습니다. 재연결을 기다립니다.",
        });
      }
    }
  }

  #maybeResume(): void {
    const receiver = this.#receiver;
    if (!receiver || this.#resumeInFlight || this.#terminal) return;
    if (!this.#peer?.isChannelOpen) return;
    if (receiver.state !== "transferring" && receiver.state !== "reconnecting") return;
    this.#resumeInFlight = true;
    void receiver.prepareResume().then((offset) => {
      if (offset === null) this.#resumeInFlight = false;
    }).catch(() => {
      this.#resumeInFlight = false;
    });
  }

  #onReceiverEvent(event: ReceiverEvent): void {
    switch (event.type) {
      case "offer": {
        const file = event.file;
        if (this.#state.fileName && this.#state.fileName !== file.name) return;
        this.#patch({
          phase: this.#receiver?.state === "transferring" ? "transferring" : "offer",
          fileName: file.name,
          fileSize: BigInt(file.size),
          mime: file.mime ?? null,
          progress: {
            done: 0n,
            total: BigInt(file.size),
            bytesPerSecond: 0,
            etaMs: null,
          },
          canChooseDestination: this.#receiver?.state === "awaiting-accept",
          notice: "파일 정보를 확인하고 저장 위치를 선택하세요.",
        });
        return;
      }
      case "state":
        if (event.state === "transferring") {
          this.#resumeInFlight = false;
          this.#patch({ phase: "transferring" });
        } else if (event.state === "reconnecting") {
          this.#patch({ phase: "reconnecting" });
        } else if (event.state === "verifying") {
          this.#patch({ phase: "verifying" });
        }
        return;
      case "progress":
        this.#patch({
          phase:
            this.#state.phase === "offer" || this.#state.phase === "awaiting-offer"
              ? "transferring"
              : this.#state.phase,
          progress: {
            done: event.appliedBytes,
            total: event.totalBytes,
            bytesPerSecond: event.bytesPerSecond,
            etaMs: event.etaMs,
          },
          ...(this.#state.startedAt === 0 ? { startedAt: Date.now() } : {}),
        });
        return;
      case "resume-requested":
        this.#patch({
          phase: "reconnecting",
          notice: "저장된 위치를 확인하고 전송 재개를 요청했습니다.",
        });
        return;
      case "transport-lost":
        this.#patch({
          phase: "reconnecting",
          notice: "데이터 연결이 끊겼습니다. 재연결을 기다립니다.",
        });
        return;
      case "verifying":
        this.#patch({ phase: "verifying", notice: "크기와 SHA-256을 확인하는 중입니다." });
        return;
      case "completed":
        this.#terminal = true;
        this.#patch({
          phase: "completed",
          sha256: event.sha256,
          canChooseDestination: false,
          notice: null,
          finishedAt: Date.now(),
        });
        // Keep the DataChannel and signaling room alive briefly: if the sender
        // missed `verified`, it retries `finish` and we answer again.
        this.#graceTimer = window.setTimeout(() => this.#cleanup(), 45_000);
        return;
      case "cancelled":
        this.#terminal = true;
        this.#patch({ phase: "cancelled", notice: "전송이 취소되었습니다.", finishedAt: Date.now() });
        this.#cleanup();
        return;
      case "failed":
        this.#fail(event.code, event.message, event.partialBytes);
        return;
    }
  }

  #isTransferActive(): boolean {
    const state = this.#receiver?.state;
    return (
      state === "transferring" ||
      state === "reconnecting" ||
      state === "verifying" ||
      this.#state.phase === "transferring" ||
      this.#state.phase === "verifying"
    );
  }

  #fail(code: string, message: string, partialBytes?: bigint): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#patch({
      phase: "failed",
      error: { code, message },
      partialBytes: partialBytes ?? null,
      finishedAt: Date.now(),
    });
    if (this.#receiver && !["completed", "cancelled", "failed"].includes(this.#receiver.state)) {
      void this.#receiver.cancel(code, message).catch(() => {});
    }
    this.#cleanup();
  }

  #failFrom(error: unknown): void {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code: unknown }).code);
      this.#fail(code, describeRoomError(code));
      return;
    }
    this.#fail("UNKNOWN", error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.");
  }

  #patch(patch: Partial<ReceiverState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#onState(this.#state);
  }

  #cleanup(): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    if (this.#graceTimer !== null) {
      window.clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    window.removeEventListener("beforeunload", this.#beforeUnload);
    this.#closeTransport();
    this.#room?.close();
    this.#room = null;
  }

  #closeTransport(): void {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    this.#receiver?.dispose();
    this.#peer?.close();
    this.#peer = null;
    this.#factory.disposeAll();
    this.#sink = null;
  }
}
