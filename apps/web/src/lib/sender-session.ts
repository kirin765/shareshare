import {
  parseDataMessage,
  parseJson,
  type FileMetadata,
  type SignalingServerMessage,
} from "@shareshare/protocol";
import { Sender, type SenderEvent, type TransferState } from "@shareshare/transfer";
import { ChannelTransport } from "./channel-transport.js";
import { fileSource } from "./fs.js";
import { randomTransferId } from "./format.js";
import { createWorkerHasherFactory, type WorkerHasherFactory } from "./hasher.js";
import {
  SignalingRoom,
  describeRoomError,
  toRtcIceServers,
  type RoomEvent,
} from "./signaling-room.js";
import { PeerLink, type ConnectionPath, type SignalOut } from "./webrtc.js";

const FORCE_RELAY = (import.meta.env.VITE_FORCE_RELAY as string | undefined) === "true";

export type SenderPhase =
  | "starting"
  | "creating"
  | "waiting"
  | "awaiting-approval"
  | "negotiating"
  | "awaiting-accept"
  | "transferring"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "reconnecting";

export interface SenderState {
  phase: SenderPhase;
  fileName: string;
  fileSize: bigint;
  transferId: string;
  inviteUrl: string | null;
  roomId: string | null;
  connectionCode: string | null;
  progress: {
    done: bigint;
    confirmed: bigint;
    total: bigint;
    bytesPerSecond: number;
    etaMs: number | null;
  };
  path: ConnectionPath;
  error: { code: string; message: string } | null;
  notice: string | null;
  sha256: string | null;
  partialBytes: bigint | null;
  canApprove: boolean;
  reconnectAttempt: number;
  startedAt: number;
  finishedAt: number | null;
}

interface SenderSessionOptions {
  url: string;
  file: File;
  onState: (state: SenderState) => void;
}

const TERMINAL: SenderPhase[] = ["completed", "cancelled", "failed"];

export class SenderSession {
  #state: SenderState;
  #onState: (state: SenderState) => void;
  #file: File;
  #url: string;
  #room: SignalingRoom | null = null;
  #peer: PeerLink | null = null;
  #sender: Sender | null = null;
  #transport: ChannelTransport | null = null;
  #factory: WorkerHasherFactory = createWorkerHasherFactory();
  #iceServers: RTCIceServer[] = [];
  #approved = false;
  #terminal = false;
  #cleaned = false;
  #signalingOnline = true;
  #everConnected = false;
  #offering = false;
  #recoveryTimer: number | null = null;
  #recoveryAttempts = 0;
  #recoveryStartedAt: number | null = null;
  #startedAt = 0;
  #beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.#state.phase !== "transferring" && this.#state.phase !== "verifying") return;
    event.preventDefault();
    event.returnValue = "";
  };

  constructor(options: SenderSessionOptions) {
    this.#url = options.url;
    this.#file = options.file;
    this.#onState = options.onState;
    const transferId = randomTransferId();
    this.#state = {
      phase: "starting",
      fileName: options.file.name,
      fileSize: BigInt(options.file.size),
      transferId,
      inviteUrl: null,
      roomId: null,
      connectionCode: null,
      progress: {
        done: 0n,
        confirmed: 0n,
        total: BigInt(options.file.size),
        bytesPerSecond: 0,
        etaMs: null,
      },
      path: null,
      error: null,
      notice: null,
      sha256: null,
      partialBytes: null,
      canApprove: false,
      reconnectAttempt: 0,
      startedAt: 0,
      finishedAt: null,
    };
    window.addEventListener("beforeunload", this.#beforeUnload);
  }

  get state(): SenderState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#patch({ phase: "creating" });
    const metadata: FileMetadata = {
      name: this.#file.name,
      size: String(this.#file.size),
      lastModified: this.#file.lastModified,
      ...(this.#file.type ? { mime: this.#file.type.slice(0, 255) } : {}),
    };
    this.#room = new SignalingRoom({
      url: this.#url,
      transferId: this.#state.transferId,
      onEvent: (event) => this.#onRoomEvent(event),
    });
    try {
      const created = await this.#room.createRoom(metadata);
      this.#iceServers = toRtcIceServers(created.iceServers);
      const fragment = new URLSearchParams({
        r: created.roomId,
        t: created.inviteToken,
        x: this.#state.transferId,
      });

      this.#startedAt = Date.now();
      this.#patch({
        phase: "waiting",
        inviteUrl: `${window.location.origin}${window.location.pathname}#${fragment.toString()}`,
        roomId: created.roomId,
        connectionCode: created.connectionCode,
        canApprove: false,
        notice: "초대 링크를 수신자에게 전달하세요. 링크는 방이 만료되면 무효가 됩니다.",
      });
    } catch (error) {
      this.#failFrom(error);
    }
  }

  approve(): void {
    if (this.#terminal || !this.#room || !this.#state.connectionCode) return;
    try {
      this.#room.send({
        type: "approve-peer",
        connectionCode: this.#state.connectionCode,
      });
      this.#patch({ notice: "승인을 확인하는 중입니다.", canApprove: false });
    } catch (error) {
      this.#failFrom(error);
    }
  }

  cancel(): void {
    if (this.#terminal) return;
    const room = this.#room;
    this.#room = null;
    room?.leave();
    if (this.#sender) {
      this.#sender.cancel("USER_CANCELLED", "송신자가 전송을 취소했습니다.");
    }
    this.#terminal = true;
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
    if (this.#sender) this.#sender.cancel("PAGE_CLOSED", "송신자 페이지가 닫혔습니다.");
    this.#terminal = true;
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
          notice: "시그널링 서버 연결이 끊겨 재연결을 시도합니다.",
          ...(this.#state.phase === "transferring" ? { phase: "reconnecting" as const } : {}),
        });
      } else if (event.status === "connected") {
        this.#signalingOnline = true;
        const phase = this.#sender ? this.#phaseForSenderState(this.#sender.state) : this.#state.phase;
        this.#patch({
          notice: null,
          ...(!TERMINAL.includes(this.#state.phase) && this.#sender ? { phase } : {}),
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
      case "room-created":
        return;
      case "peer-joined":
        if (this.#state.phase === "waiting" || this.#state.phase === "reconnecting") {
          this.#patch({
            phase: "awaiting-approval",
            canApprove: true,
            notice:
              "수신자가 입장했습니다. 양쪽에 표시된 연결 확인 코드가 같은지 확인한 뒤 승인하세요.",
          });
        }
        return;
      case "peer-left":
        if (message.role !== "receiver") return;
        if (message.final) {
          if (this.#approved) {
            this.#fail("PEER_LEFT", "수신자가 연결을 종료했습니다.");
          } else {
            this.#approved = false;
            this.#patch({
              phase: "waiting",
              canApprove: false,
              notice: "수신자가 나갔습니다. 같은 초대 링크로 다시 입장할 수 있습니다.",
            });
          }
        } else {
          const verifying = this.#state.phase === "verifying";
          this.#patch({
            notice: verifying
              ? "수신자의 확인 응답을 기다리는 중입니다."
              : this.#peer?.isChannelOpen
                ? "수신자의 시그널링이 재연결되는 중입니다. 데이터 전송은 계속됩니다."
                : "수신자 연결이 끊겼습니다. 재연결을 기다리는 중입니다.",
            ...(this.#approved && !verifying && !this.#peer?.isChannelOpen
              ? { phase: "reconnecting" as const }
              : {}),
          });
        }
        return;
      case "peer-approved":
        this.#approved = true;
        this.#patch({
          phase: "negotiating",
          canApprove: false,
          notice: "연결을 설정하는 중입니다.",
        });
        void this.#beginPeer();
        return;
      case "peer-reconnected":
        if (message.role !== "receiver" || !this.#approved) return;
        if (this.#peer?.isChannelOpen) {
          this.#patch({
            phase: this.#phaseForSenderState(this.#sender?.state),
            notice: "수신자가 재연결했습니다.",
          });
        } else {
          this.#patch({ notice: "수신자가 재연결했습니다. 연결을 복구하는 중입니다." });
          void this.#beginPeer({ iceRestart: true });
        }
        return;
      case "resumed":
        this.#signalingOnline = true;
        this.#iceServers = toRtcIceServers(message.iceServers);
        this.#peer?.updateIceServers(this.#iceServers);
        if (!message.approved) {
          if (message.peerPresent) {
            this.#patch({
              phase: "awaiting-approval",
              canApprove: true,
              notice:
                "시그널링 연결이 복구되었습니다. 수신자가 대기 중이니 연결 확인 코드를 보고 승인하세요.",
            });
          } else {
            this.#patch({
              phase: "waiting",
              canApprove: false,
              notice: "시그널링 연결이 복구되었습니다. 수신자 입장을 기다립니다.",
            });
          }
          return;
        }
        this.#approved = true;
        if (!message.peerPresent) {
          this.#patch({
            phase: "reconnecting",
            notice: "시그널링은 복구되었습니다. 수신자의 재연결을 기다립니다.",
          });
          return;
        }
        if (this.#peer?.isChannelOpen) {
          this.#patch({
            phase: this.#phaseForSenderState(this.#sender?.state),
            notice: "시그널링 연결이 복구되었습니다.",
          });
          return;
        }
        void this.#beginPeer({ iceRestart: true, forceNew: this.#recoveryAttempts > 1 });
        return;
      case "answer":
        void this.#peer?.handleAnswer(message.sdp);
        return;
      case "ice-candidate":
        void this.#peer?.addIceCandidate(message.candidate);
        return;
      case "offer":
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

  async #beginPeer(options: { iceRestart?: boolean; forceNew?: boolean } = {}): Promise<void> {
    if (this.#terminal || !this.#approved) return;
    if (!this.#peer) {
      this.#peer = new PeerLink({
        role: "sender",
        iceServers: this.#iceServers,
        forceRelay: FORCE_RELAY,
        sendSignal: (message) => this.#sendSignal(message),
        callbacks: {
          onChannel: (channel) => this.#onChannel(channel),
          onData: (data) => this.#onData(data),
          onChannelClosed: () => this.#onChannelClosed(),
          onState: (state) => this.#onPeerState(state),
          onPath: (path) => this.#patch({ path }),
          onError: (error) => {
            this.#patch({ notice: error.message });
            if (!this.#peer?.isChannelOpen) this.#scheduleRecovery(false);
          },
        },
      });
    }
    if (this.#peer.isChannelOpen || this.#offering) return;
    const pc = this.#peer.pc;
    if (!options.forceNew && pc && pc.signalingState !== "stable") {
      this.#scheduleRecovery(true);
      return;
    }
    this.#offering = true;
    try {
      await this.#peer.startOffer(options);
    } finally {
      this.#offering = false;
    }
  }

  #sendSignal(message: SignalOut): void {
    if (!this.#room) return;
    try {
      this.#room.send(message as unknown as Record<string, unknown> & { type: string });
    } catch {
      // Signaling will reconnect; the resumed handler restarts negotiation.
    }
  }

  #onChannel(channel: RTCDataChannel): void {
    if (this.#terminal || this.#cleaned) return;
    this.#recoveryAttempts = 0;
    this.#recoveryStartedAt = null;
    this.#clearRecovery();
    this.#transport = new ChannelTransport(channel);
    if (!this.#sender) {
      this.#sender = new Sender({
        transferId: this.#state.transferId,
        source: fileSource(this.#file),
        file: {
          name: this.#file.name,
          size: String(this.#file.size),
          lastModified: this.#file.lastModified,
          ...(this.#file.type ? { mime: this.#file.type.slice(0, 255) } : {}),
        },
        transport: this.#transport,
        hasherFactory: () => this.#factory.create(),
        onEvent: (event) => this.#onSenderEvent(event),
      });
    } else {
      this.#sender.setTransport(this.#transport);
    }

    if (!this.#sender.started) {
      this.#sender.start();
      this.#patch({ phase: "awaiting-accept", notice: "수신자가 파일 정보를 확인하고 있습니다." });
    } else {
      this.#sender.resendOffer();
      if (this.#sender.state === "awaiting-accept") {
        this.#patch({ phase: "awaiting-accept" });
      }
    }
  }

  #onData(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const json = parseJson(data);
    if (json === null) {
      this.#fail("PROTOCOL_ERROR", "올바르지 않은 제어 메시지를 받았습니다.");
      return;
    }
    try {
      const message = parseDataMessage(json);
      this.#sender?.handleControl(message);
    } catch {
      this.#fail("PROTOCOL_ERROR", "제어 메시지 형식이 올바르지 않습니다.");
    }
  }

  #onChannelClosed(): void {
    if (this.#terminal) return;
    this.#sender?.pause();
    this.#patch({
      phase: "reconnecting",
      notice: "데이터 연결이 끊겼습니다. 재연결을 시도합니다.",
    });
    this.#scheduleRecovery(false);
  }

  #onPeerState(state: RTCPeerConnectionState): void {
    if (this.#terminal) return;
    if (state === "connected") {
      this.#everConnected = true;
      this.#recoveryAttempts = 0;
      this.#recoveryStartedAt = null;
      this.#clearRecovery();
      const senderState = this.#sender?.state;
      const phase = this.#phaseForSenderState(senderState);
      this.#patch({ phase, notice: phase === "reconnecting" ? "전송을 재개하는 중입니다." : null });
      return;
    }
    if (state === "disconnected") {
      this.#sender?.pause();
      this.#patch({
        phase: "reconnecting",
        notice: "네트워크 연결이 잠시 끊겼습니다. 복구를 시도합니다.",
      });
      this.#scheduleRecovery(false);
      return;
    }
    if (state === "failed" || state === "closed") {
      this.#sender?.pause();
      this.#patch({
        phase: "reconnecting",
        notice: "데이터 연결이 실패했습니다. 새 연결을 만듭니다.",
      });
      this.#scheduleRecovery(true);
    }
  }

  #phaseForSenderState(state: TransferState | undefined): SenderPhase {
    switch (state) {
      case "transferring":
        return "transferring";
      case "verifying":
        return "verifying";
      case "completed":
        return "completed";
      case "reconnecting":
        return "reconnecting";
      case "awaiting-accept":
        return "awaiting-accept";
      default:
        return this.#everConnected ? "awaiting-accept" : "negotiating";
    }
  }

  #scheduleRecovery(forceNew: boolean): void {
    if (this.#terminal || !this.#approved) return;
    if (!this.#signalingOnline) return;
    if (this.#peer?.isChannelOpen) return;
    this.#clearRecovery();
    if (this.#recoveryStartedAt === null) this.#recoveryStartedAt = Date.now();
    const attempt = this.#recoveryAttempts + 1;
    this.#recoveryAttempts = attempt;
    this.#patch({ reconnectAttempt: attempt });
    if (Date.now() - this.#recoveryStartedAt > 90_000 || attempt > 20) {
      this.#fail("TRANSPORT_ERROR", "데이터 연결을 복구하지 못했습니다.");
      return;
    }
    const delay = forceNew ? 800 : Math.min(5000, 1000 * attempt);
    this.#recoveryTimer = window.setTimeout(() => {
      this.#recoveryTimer = null;
      if (this.#terminal || !this.#approved || this.#peer?.isChannelOpen) return;
      if (!this.#signalingOnline) return;
      void this.#beginPeer({
        iceRestart: attempt < 2,
        forceNew: forceNew || attempt >= 2,
      });
    }, delay);
  }

  #onSenderEvent(event: SenderEvent): void {
    switch (event.type) {
      case "state":
        if (event.state === "transferring") this.#patch({ phase: "transferring" });
        else if (event.state === "verifying") this.#patch({ phase: "verifying" });
        else if (event.state === "reconnecting") this.#patch({ phase: "reconnecting" });
        return;
      case "progress":
        this.#patch({
          phase:
            this.#state.phase === "awaiting-accept" ? "transferring" : this.#state.phase,
          progress: {
            done: event.sentBytes,
            confirmed: event.ackedBytes,
            total: event.totalBytes,
            bytesPerSecond: event.bytesPerSecond,
            etaMs: event.etaMs,
          },
        });
        return;
      case "resuming":
        this.#patch({
          phase: "transferring",
          notice: "저장된 위치부터 전송을 재개합니다.",
        });
        return;
      case "transport-lost":
        this.#sender?.pause();
        this.#patch({
          phase: "reconnecting",
          notice: "데이터 연결이 끊겼습니다. 재연결을 시도합니다.",
        });
        this.#scheduleRecovery(false);
        return;
      case "completed":
        this.#finish("completed", { sha256: event.sha256, notice: null });
        return;
      case "cancelled":
        this.#terminal = true;
        this.#patch({ phase: "cancelled", notice: "전송을 취소했습니다." });
        this.#cleanup();
        return;
      case "failed":
        this.#fail(event.code, event.message, event.partialBytes);
        return;
      case "offer-sent":
      case "verified":
        return;
    }
  }

  #finish(phase: "completed", patch: Partial<SenderState>): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#patch({
      phase,
      finishedAt: Date.now(),
      ...patch,
    });
    this.#cleanup();
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

  #patch(patch: Partial<SenderState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#onState(this.#state);
  }

  #clearRecovery(): void {
    if (this.#recoveryTimer !== null) {
      window.clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
  }

  #cleanup(): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#clearRecovery();
    window.removeEventListener("beforeunload", this.#beforeUnload);
    try {
      this.#sender?.dispose();
    } catch {
      /* ignore */
    }
    this.#peer?.close();
    this.#peer = null;
    this.#room?.close();
    this.#room = null;
    this.#factory.disposeAll();
  }
}
