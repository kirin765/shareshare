import {
  PROTOCOL_VERSION,
  parseJson,
  parseSignalingServerMessage,
  type FileMetadata,
  type IceServerConfig,
  type SignalingErrorCode,
  type SignalingServerMessage,
} from "@shareshare/protocol";

export class RoomError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "RoomError";
    this.code = code;
  }
}

export type RoomEvent =
  | { type: "message"; message: SignalingServerMessage }
  | { type: "status"; status: "connected" | "reconnecting" | "closed" }
  | { type: "fatal"; code: string; message?: string };

interface PendingRequest {
  type: string;
  resolve: (message: SignalingServerMessage) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface RoomOptions {
  url: string;
  transferId: string;
  onEvent: (event: RoomEvent) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 30;

function isFatalResumeError(code: string): boolean {
  return (
    code === "ROOM_NOT_FOUND" ||
    code === "ROOM_EXPIRED" ||
    code === "INVALID_CREDENTIAL" ||
    code === "UNSUPPORTED_VERSION"
  );
}

/**
 * Owns the signaling WebSocket, room credentials, heartbeat, and reconnect
 * handshake. It never logs or persists tokens.
 */
export class SignalingRoom {
  readonly transferId: string;
  readonly #url: string;
  readonly #onEvent: (event: RoomEvent) => void;

  #ws: WebSocket | null = null;
  #opening: Promise<void> | null = null;
  #pending: PendingRequest | null = null;
  #heartbeatTimer: number | null = null;
  #reconnectTimer: number | null = null;
  #reconnectAttempts = 0;
  #roomId: string | null = null;
  #sessionToken: string | null = null;
  #manualClose = false;
  #fatal = false;
  #openResolvers: Array<() => void> = [];

  constructor(options: RoomOptions) {
    this.#url = options.url;
    this.transferId = options.transferId;
    this.#onEvent = options.onEvent;
  }

  get roomId(): string | null {
    return this.#roomId;
  }

  async createRoom(file: FileMetadata): Promise<Extract<SignalingServerMessage, { type: "room-created" }>> {
    await this.#ensureOpen();
    const response = await this.#request(
      { type: "create-room", file },
      "room-created",
    );
    const created = response as Extract<SignalingServerMessage, { type: "room-created" }>;
    this.#roomId = created.roomId;
    this.#sessionToken = created.senderToken;
    this.#onEvent({ type: "message", message: created });
    return created;
  }

  async joinRoom(
    roomId: string,
    inviteToken: string,
  ): Promise<Extract<SignalingServerMessage, { type: "joined" }>> {
    await this.#ensureOpen();
    const response = await this.#request(
      { type: "join-room", roomId, inviteToken },
      "joined",
    );
    const joined = response as Extract<SignalingServerMessage, { type: "joined" }>;
    this.#roomId = joined.roomId;
    this.#sessionToken = joined.sessionToken;
    this.#onEvent({ type: "message", message: joined });
    return joined;
  }

  send(message: Record<string, unknown> & { type: string }): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new RoomError("SIGNALING_DISCONNECTED", "시그널링 연결이 끊겼습니다.");
    }
    this.#ws.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        transferId: this.transferId,
        ...message,
      }),
    );
  }

  close(): void {
    this.#manualClose = true;
    this.#clearTimers();
    if (this.#pending) {
      this.#pending.reject(new RoomError("CLOSED", "room closed"));
      this.#pending = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000, "client closed");
      } catch {
        /* already closed */
      }
    }
    this.#onEvent({ type: "status", status: "closed" });
  }

  /** Tell the server this is an intentional leave, then close the socket. */
  leave(): void {
    if (this.#manualClose) return;
    this.#manualClose = true;
    this.#clearTimers();
    try {
      if (this.#ws?.readyState === WebSocket.OPEN) this.send({ type: "leave-room" });
    } catch {
      /* close below */
    }
    window.setTimeout(() => this.close(), 50);
  }

  #ensureOpen(): Promise<void> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#ws && this.#ws.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve) => this.#openResolvers.push(resolve));
    }
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  #open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const ws = new WebSocket(this.#url);
      this.#ws = ws;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.onopen = () => {
        opened = true;
        settled = true;
        this.#startHeartbeat();
        for (const resolveOpen of this.#openResolvers.splice(0)) resolveOpen();
        resolve();
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        this.#handleRaw(event.data);
      };
      ws.onerror = () => {
        if (!opened) fail(new RoomError("SIGNALING_ERROR", "시그널링 서버에 연결하지 못했습니다."));
      };
      ws.onclose = () => {
        if (!opened) fail(new RoomError("SIGNALING_ERROR", "시그널링 서버에 연결하지 못했습니다."));
        this.#handleClose(ws);
      };
    });
  }

  #handleRaw(raw: unknown): void {
    if (typeof raw !== "string") return;
    const json = parseJson(raw);
    if (json === null) return;
    let message: SignalingServerMessage;
    try {
      message = parseSignalingServerMessage(json);
    } catch {
      return;
    }
    if (message.type === "heartbeat-ack") return;

    if (message.type === "error") {
      if (this.#pending) {
        const pending = this.#pending;
        this.#pending = null;
        window.clearTimeout(pending.timer);
        pending.reject(new RoomError(message.code, message.message));
        return;
      }
      this.#onEvent({ type: "message", message });
      return;
    }

    if (message.type === "room-expired") {
      this.#fatal = true;
      this.#onEvent({ type: "message", message });
      this.#onEvent({ type: "fatal", code: "ROOM_EXPIRED" });
      this.close();
      return;
    }

    const pending = this.#pending;
    if (pending && pending.type === message.type) {
      this.#pending = null;
      window.clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    this.#onEvent({ type: "message", message });
  }

  #request(
    payload: Record<string, unknown> & { type: string },
    expectedType: string,
  ): Promise<SignalingServerMessage> {
    if (this.#pending) {
      this.#pending.reject(new RoomError("BUSY", "another signaling request is in flight"));
      this.#pending = null;
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.#pending?.timer === timer) this.#pending = null;
        reject(new RoomError("TIMEOUT", "시그널링 응답 시간이 초과되었습니다."));
      }, REQUEST_TIMEOUT_MS);
      this.#pending = { type: expectedType, resolve, reject, timer };
      try {
        this.send(payload);
      } catch (error) {
        window.clearTimeout(timer);
        this.#pending = null;
        reject(error instanceof Error ? error : new RoomError("SEND_FAILED"));
      }
    });
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = window.setInterval(() => {
      try {
        this.send({ type: "heartbeat" });
      } catch {
        /* close handler will reconnect */
      }
    }, HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      window.clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #handleClose(ws: WebSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#stopHeartbeat();
    if (this.#pending) {
      const pending = this.#pending;
      this.#pending = null;
      window.clearTimeout(pending.timer);
      pending.reject(new RoomError("SIGNALING_DISCONNECTED"));
    }
    if (this.#manualClose || this.#fatal) {
      this.#onEvent({ type: "status", status: "closed" });
      return;
    }
    if (!this.#sessionToken || !this.#roomId) {
      this.#onEvent({ type: "status", status: "closed" });
      return;
    }
    this.#onEvent({ type: "status", status: "reconnecting" });
    this.#scheduleReconnect(250);
  }

  #scheduleReconnect(delay: number): void {
    if (this.#manualClose || this.#fatal) return;
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.#onEvent({ type: "fatal", code: "SIGNALING_DISCONNECTED" });
      this.close();
      return;
    }
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = window.setTimeout(() => {
      void this.#attemptResume();
    }, delay);
  }

  async #attemptResume(): Promise<void> {
    if (this.#manualClose || this.#fatal || !this.#sessionToken || !this.#roomId) return;
    try {
      await this.#ensureOpen();
      const resumed = (await this.#request(
        {
          type: "resume-session",
          roomId: this.#roomId,
          sessionToken: this.#sessionToken,
        },
        "resumed",
      )) as Extract<SignalingServerMessage, { type: "resumed" }>;
      this.#reconnectAttempts = 0;
      this.#onEvent({ type: "status", status: "connected" });
      this.#onEvent({ type: "message", message: resumed });
    } catch (error) {
      const code = error instanceof RoomError ? error.code : "SIGNALING_ERROR";
      if (isFatalResumeError(code)) {
        this.#fatal = true;
        this.#onEvent({ type: "fatal", code });
        this.close();
        return;
      }
      const nextDelay = Math.min(5000, 500 * 2 ** Math.min(this.#reconnectAttempts, 4));
      this.#scheduleReconnect(nextDelay);
    }
  }

  #clearTimers(): void {
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== null) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }
}

export function toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
  return servers.map((server) => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {}),
  }));
}

export function describeRoomError(code: string): string {
  const messages: Record<string, string> = {
    ROOM_NOT_FOUND: "방을 찾을 수 없습니다. 초대 링크가 만료되었는지 확인하세요.",
    ROOM_EXPIRED: "방이 만료되었습니다. 송신자에게 새 링크를 요청하세요.",
    INVALID_CREDENTIAL: "초대 링크가 올바르지 않거나 이미 사용할 수 없습니다.",
    ROOM_FULL: "이미 수신자가 연결된 방입니다.",
    ALREADY_APPROVED: "이미 승인된 방입니다. 기존 수신자만 재연결할 수 있습니다.",
    NOT_APPROVED: "송신자가 아직 연결을 승인하지 않았습니다.",
    NOT_ROOM_OWNER: "이 작업은 송신자만 할 수 있습니다.",
    BAD_CONNECTION_CODE: "연결 확인 코드가 일치하지 않습니다.",
    RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
    MESSAGE_TOO_LARGE: "메시지가 너무 큽니다.",
    SERVER_BUSY: "서버가 혼잡합니다. 잠시 후 다시 시도하세요.",
    SESSION_DISCONNECTED: "상대방의 연결이 끊겼습니다. 재연결을 기다리는 중입니다.",
    SIGNALING_DISCONNECTED: "시그널링 서버와의 연결이 끊겼습니다.",
    SIGNALING_ERROR: "시그널링 서버에 연결할 수 없습니다.",
    TIMEOUT: "서버 응답 시간이 초과되었습니다.",
  };
  return messages[code] ?? "연결 중 오류가 발생했습니다.";
}
