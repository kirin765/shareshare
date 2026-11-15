import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import {
  PROTOCOL_VERSION,
  parseJson,
  parseSignalingClientMessage,
  type IceServerConfig,
  type SignalingClientMessage,
  type SignalingErrorCode,
  type SignalingServerMessage,
} from "@shareshare/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, type SignalingConfig } from "./config.js";
import { RateLimiter } from "./rate-limit.js";
import { buildIceServers, type TurnSettings } from "./turn.js";

type Role = "sender" | "receiver";

interface PeerRecord {
  role: Role;
  socket: WebSocket | null;
  sessionHash: string;
  lastSeen: number;
  graceTimer: NodeJS.Timeout | null;
}

interface Room {
  id: string;
  transferId: string;
  createdAt: number;
  lastActivity: number;
  connectionCode: string;
  senderTokenHash: string;
  inviteTokenHash: string;
  sender: PeerRecord;
  receiver: PeerRecord | null;
  status: "waiting" | "awaiting-approval" | "approved" | "closed";
}

interface SocketState {
  id: string;
  ip: string;
  socket: WebSocket;
  roomId: string | null;
  role: Role | null;
  lastSeen: number;
}

export interface SignalingServerHandle {
  readonly config: SignalingConfig;
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;
  readonly roomCount: number;
  listen(): Promise<number>;
  close(): Promise<void>;
}

const ONE_MINUTE = 60_000;

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMatches(expectedHash: string, candidate: string): boolean {
  const actual = Buffer.from(hashToken(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function codeMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected.padEnd(8, "0"), "utf8");
  const b = Buffer.from(candidate.padEnd(8, "0"), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function connectionCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function openSocket(socket: WebSocket | null): socket is WebSocket {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

export function createSignalingServer(
  overrides: Partial<SignalingConfig> = {},
): SignalingServerHandle {
  const config: SignalingConfig = { ...loadConfig({}), ...overrides };
  const now = config.now;
  const logger = config.logger;
  const turn: TurnSettings | null =
    config.turnUrls.length > 0 && config.turnSecret.length > 0
      ? {
          urls: config.turnUrls,
          secret: config.turnSecret,
          ttlSeconds: config.turnTtlSeconds,
          realm: config.turnRealm,
        }
      : null;

  const rooms = new Map<string, Room>();
  const states = new WeakMap<WebSocket, SocketState>();
  const sockets = new Set<WebSocket>();
  const attachLimiter = new RateLimiter(config.maxAttachAttemptsPerMinute, ONE_MINUTE, now);
  const messageLimiter = new RateLimiter(config.maxMessagesPerMinute, ONE_MINUTE, now);
  let closing = false;

  const httpServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ShareShare signaling server. Connect over /ws.\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(config.maxMessageBytes * 4, 256 * 1024),
    perMessageDeflate: false,
  });

  function originAllowed(origin: string | undefined): boolean {
    if (config.allowedOrigins.includes("*")) return true;
    if (!origin) return config.allowMissingOrigin;
    return config.allowedOrigins.includes(origin);
  }

  httpServer.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!originAllowed(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  function send(socket: WebSocket, message: SignalingServerMessage): void {
    if (!openSocket(socket)) return;
    socket.send(JSON.stringify(message));
  }

  function sendError(
    socket: WebSocket,
    code: SignalingErrorCode,
    transferId?: string,
    message?: string,
  ): void {
    send(socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      code,
      ...(transferId && transferId.length >= 8 ? { transferId } : {}),
      ...(message ? { message: message.slice(0, 300) } : {}),
    });
  }

  function iceServers(): IceServerConfig[] {
    return buildIceServers(
      { stunUrls: config.stunUrls, turn },
      now(),
    );
  }

  function refreshRoom(room: Room): void {
    room.lastActivity = now();
  }

  function expiresAt(room: Room): number {
    return room.lastActivity + config.roomTtlMs;
  }

  function findPeer(room: Room, role: Role): PeerRecord | null {
    return role === "sender" ? room.sender : room.receiver;
  }

  function notifyPeer(room: Room, role: Role, message: SignalingServerMessage): void {
    const peer = findPeer(room, role);
    if (peer && openSocket(peer.socket)) send(peer.socket, message);
  }

  function clearPeerTimer(peer: PeerRecord): void {
    if (peer.graceTimer !== null) {
      clearTimeout(peer.graceTimer);
      peer.graceTimer = null;
    }
  }

  function deleteRoom(room: Room): void {
    room.status = "closed";
    rooms.delete(room.id);
    clearPeerTimer(room.sender);
    if (room.receiver) clearPeerTimer(room.receiver);
  }

  function closePeerSocket(peer: PeerRecord | null): void {
    if (peer && openSocket(peer.socket)) peer.socket.close(1000, "room closed");
    if (peer) peer.socket = null;
  }

  function closeRoom(room: Room): void {
    if (room.status === "closed") return;
    deleteRoom(room);
    closePeerSocket(room.sender);
    closePeerSocket(room.receiver);
  }

  function expireRoom(room: Room): void {
    if (room.status === "closed") return;
    const expired: SignalingServerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "room-expired",
    };
    notifyPeer(room, "sender", expired);
    notifyPeer(room, "receiver", expired);
    deleteRoom(room);
    closePeerSocket(room.sender);
    closePeerSocket(room.receiver);
  }

  function attachedState(ws: WebSocket): { state: SocketState; room: Room } | null {
    const state = states.get(ws);
    if (!state || !state.roomId) return null;
    const room = rooms.get(state.roomId);
    if (!room || room.status === "closed") return null;
    return { state, room };
  }

  function attach(
    state: SocketState,
    room: Room,
    role: Role,
    peer: PeerRecord,
  ): void {
    state.roomId = room.id;
    state.role = role;
    peer.socket = state.socket;
    peer.lastSeen = now();
    clearPeerTimer(peer);
    refreshRoom(room);
  }

  function handleCreateRoom(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "create-room") return;
    if (state.roomId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (!attachLimiter.allow(state.ip)) {
      sendError(state.socket, "RATE_LIMITED", message.transferId);
      return;
    }
    if (rooms.size >= config.maxRooms) {
      sendError(state.socket, "SERVER_BUSY", message.transferId);
      return;
    }

    const id = token(16);
    const senderToken = token();
    const inviteToken = token();
    const timestamp = now();
    const room: Room = {
      id,
      transferId: message.transferId,
      createdAt: timestamp,
      lastActivity: timestamp,
      connectionCode: connectionCode(),
      senderTokenHash: hashToken(senderToken),
      inviteTokenHash: hashToken(inviteToken),
      status: "waiting",
      sender: {
        role: "sender",
        socket: null,
        sessionHash: hashToken(senderToken),
        lastSeen: timestamp,
        graceTimer: null,
      },
      receiver: null,
    };
    rooms.set(id, room);
    attach(state, room, "sender", room.sender);

    send(state.socket, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "room-created",
      roomId: room.id,
      senderToken,
      inviteToken,
      connectionCode: room.connectionCode,
      expiresAt: expiresAt(room),
      iceServers: iceServers(),
    });
    logger.info("room_created", { activeRooms: rooms.size });
  }

  function handleJoinRoom(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "join-room") return;
    if (state.roomId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (!attachLimiter.allow(state.ip)) {
      sendError(state.socket, "RATE_LIMITED", message.transferId);
      return;
    }
    const room = rooms.get(message.roomId);
    if (!room || room.status === "closed" || room.transferId !== message.transferId) {
      sendError(state.socket, "ROOM_NOT_FOUND", message.transferId);
      return;
    }
    if (room.status === "approved") {
      sendError(state.socket, "ALREADY_APPROVED", message.transferId);
      return;
    }
    if (!tokenMatches(room.inviteTokenHash, message.inviteToken)) {
      sendError(state.socket, "INVALID_CREDENTIAL", message.transferId);
      return;
    }
    if (room.receiver) {
      sendError(state.socket, "ROOM_FULL", message.transferId);
      return;
    }

    const sessionToken = token();
    room.receiver = {
      role: "receiver",
      socket: null,
      sessionHash: hashToken(sessionToken),
      lastSeen: now(),
      graceTimer: null,
    };
    room.status = "awaiting-approval";
    attach(state, room, "receiver", room.receiver);

    send(state.socket, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "joined",
      roomId: room.id,
      sessionToken,
      connectionCode: room.connectionCode,
      expiresAt: expiresAt(room),
      senderPresent: openSocket(room.sender.socket),
      iceServers: iceServers(),
    });
    notifyPeer(room, "sender", {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "peer-joined",
      role: "receiver",
    });
    logger.info("receiver_joined", { activeRooms: rooms.size });
  }

  function handleResumeSession(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "resume-session") return;
    if (state.roomId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (!attachLimiter.allow(state.ip)) {
      sendError(state.socket, "RATE_LIMITED", message.transferId);
      return;
    }
    const room = rooms.get(message.roomId);
    if (!room || room.status === "closed" || room.transferId !== message.transferId) {
      sendError(state.socket, "ROOM_NOT_FOUND", message.transferId);
      return;
    }

    let role: Role | null = null;
    let peer: PeerRecord | null = null;
    if (tokenMatches(room.senderTokenHash, message.sessionToken)) {
      role = "sender";
      peer = room.sender;
    } else if (room.receiver && tokenMatches(room.receiver.sessionHash, message.sessionToken)) {
      role = "receiver";
      peer = room.receiver;
    }
    if (!role || !peer) {
      sendError(state.socket, "INVALID_CREDENTIAL", message.transferId);
      return;
    }

    if (openSocket(peer.socket) && peer.socket !== state.socket) {
      peer.socket.close(4000, "session resumed elsewhere");
    }
    attach(state, room, role, peer);

    const other = findPeer(room, role === "sender" ? "receiver" : "sender");
    send(state.socket, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "resumed",
      roomId: room.id,
      role,
      connectionCode: room.connectionCode,
      expiresAt: expiresAt(room),
      approved: room.status === "approved",
      peerPresent: openSocket(other?.socket ?? null),
      iceServers: iceServers(),
    });
    if (other && openSocket(other.socket)) {
      send(other.socket, {
        protocolVersion: PROTOCOL_VERSION,
        transferId: room.transferId,
        type: "peer-reconnected",
        role,
      });
    }
    logger.info("session_resumed", { role });
  }

  function handleApprove(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "approve-peer") return;
    const attached = attachedState(state.socket);
    if (!attached) {
      sendError(state.socket, "ROOM_NOT_FOUND", message.transferId);
      return;
    }
    const { room } = attached;
    if (state.role !== "sender") {
      sendError(state.socket, "NOT_ROOM_OWNER", message.transferId);
      return;
    }
    if (room.transferId !== message.transferId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (room.status !== "awaiting-approval" || !room.receiver) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (!codeMatches(room.connectionCode, message.connectionCode)) {
      sendError(state.socket, "BAD_CONNECTION_CODE", message.transferId);
      return;
    }
    room.status = "approved";
    refreshRoom(room);
    const approved: SignalingServerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "peer-approved",
    };
    notifyPeer(room, "sender", approved);
    notifyPeer(room, "receiver", approved);
    logger.info("peer_approved");
  }

  function handleRelay(state: SocketState, message: SignalingClientMessage): void {
    if (
      message.type !== "offer" &&
      message.type !== "answer" &&
      message.type !== "ice-candidate"
    ) {
      return;
    }
    const attached = attachedState(state.socket);
    if (!attached) {
      sendError(state.socket, "ROOM_NOT_FOUND", message.transferId);
      return;
    }
    const { room } = attached;
    if (room.transferId !== message.transferId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    if (room.status !== "approved") {
      sendError(state.socket, "NOT_APPROVED", message.transferId);
      return;
    }
    if (message.type === "offer" && state.role !== "sender") {
      sendError(state.socket, "NOT_ROOM_OWNER", message.transferId);
      return;
    }
    if (message.type === "answer" && state.role !== "receiver") {
      sendError(state.socket, "NOT_ROOM_OWNER", message.transferId);
      return;
    }

    const otherPeer = findPeer(room, state.role === "sender" ? "receiver" : "sender");
    if (!otherPeer || !openSocket(otherPeer.socket)) {
      sendError(state.socket, "SESSION_DISCONNECTED", message.transferId);
      return;
    }
    refreshRoom(room);
    send(otherPeer.socket, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: message.type,
      ...(message.type === "ice-candidate"
        ? { candidate: message.candidate }
        : { sdp: message.sdp }),
    } as SignalingServerMessage);
  }

  function handleHeartbeat(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "heartbeat") return;
    const attached = attachedState(state.socket);
    if (attached) {
      const peer = findPeer(attached.room, state.role ?? "sender");
      if (peer && peer.socket === state.socket) peer.lastSeen = now();
      refreshRoom(attached.room);
    }
    send(state.socket, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: message.transferId,
      type: "heartbeat-ack",
      receivedAt: now(),
    });
  }

  function handleLeave(state: SocketState, message: SignalingClientMessage): void {
    if (message.type !== "leave-room") return;
    const attached = attachedState(state.socket);
    if (!attached) return;
    const { room } = attached;
    if (room.transferId !== message.transferId) {
      sendError(state.socket, "INVALID_MESSAGE", message.transferId);
      return;
    }
    const role = state.role;
    if (!role) return;

    if (role === "receiver" && room.status !== "approved") {
      room.receiver = null;
      room.status = "waiting";
      refreshRoom(room);
      notifyPeer(room, "sender", {
        protocolVersion: PROTOCOL_VERSION,
        transferId: room.transferId,
        type: "peer-left",
        role: "receiver",
        final: true,
      });
      state.roomId = null;
      state.role = null;
      return;
    }

    notifyPeer(room, role === "sender" ? "receiver" : "sender", {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "peer-left",
      role,
      final: true,
    });
    closeRoom(room);
    logger.info("room_closed", { reason: "leave" });
  }

  function dispatch(state: SocketState, message: SignalingClientMessage): void {
    switch (message.type) {
      case "create-room":
        handleCreateRoom(state, message);
        break;
      case "join-room":
        handleJoinRoom(state, message);
        break;
      case "resume-session":
        handleResumeSession(state, message);
        break;
      case "approve-peer":
        handleApprove(state, message);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        handleRelay(state, message);
        break;
      case "heartbeat":
        handleHeartbeat(state, message);
        break;
      case "leave-room":
        handleLeave(state, message);
        break;
    }
  }

  function handleDisconnect(ws: WebSocket): void {
    const state = states.get(ws);
    if (!state || !state.roomId) return;
    if (closing) return;
    const room = rooms.get(state.roomId);
    if (!room) return;
    const role = state.role;
    if (!role) return;
    const peer = findPeer(room, role);
    if (!peer || peer.socket !== ws) return;
    peer.socket = null;
    peer.lastSeen = now();
    clearPeerTimer(peer);

    notifyPeer(room, role === "sender" ? "receiver" : "sender", {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "peer-left",
      role,
      final: false,
    });
    if (config.reconnectGraceMs === 0) {
      handleGraceExpiry(room.id, role);
      return;
    }
    peer.graceTimer = setTimeout(() => handleGraceExpiry(room.id, role), config.reconnectGraceMs);
    peer.graceTimer.unref?.();
  }

  function handleGraceExpiry(roomId: string, role: Role): void {
    const room = rooms.get(roomId);
    if (!room || room.status === "closed") return;
    const peer = findPeer(room, role);
    if (!peer || peer.socket !== null) return;

    if (role === "receiver" && room.status !== "approved") {
      room.receiver = null;
      room.status = "waiting";
      refreshRoom(room);
      notifyPeer(room, "sender", {
        protocolVersion: PROTOCOL_VERSION,
        transferId: room.transferId,
        type: "peer-left",
        role,
        final: true,
      });
      return;
    }

    const otherRole: Role = role === "sender" ? "receiver" : "sender";
    notifyPeer(room, otherRole, {
      protocolVersion: PROTOCOL_VERSION,
      transferId: room.transferId,
      type: "peer-left",
      role,
      final: true,
    });
    closeRoom(room);
    logger.info("room_closed", { reason: "peer_left" });
  }

  function sweep(): void {
    const timestamp = now();
    for (const room of [...rooms.values()]) {
      if (timestamp - room.lastActivity > config.roomTtlMs) {
        expireRoom(room);
        logger.info("room_expired", { activeRooms: rooms.size });
        continue;
      }
      for (const role of ["sender", "receiver"] as const) {
        const peer = findPeer(room, role);
        if (!peer || !openSocket(peer.socket)) continue;
        if (timestamp - peer.lastSeen > config.heartbeatTimeoutMs) {
          peer.socket.terminate();
        }
      }
    }
    for (const socket of [...sockets]) {
      const state = states.get(socket);
      if (state && timestamp - state.lastSeen > config.heartbeatTimeoutMs) {
        socket.terminate();
      }
    }
    attachLimiter.sweep();
    messageLimiter.sweep();
  }

  const sweepTimer = setInterval(sweep, config.sweepIntervalMs);
  sweepTimer.unref?.();

  wss.on("connection", (ws, request) => {
    if (closing) {
      ws.close(1001, "server shutting down");
      return;
    }
    const forwarded = config.trustProxy
      ? request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
      : undefined;
    const ip = forwarded || request.socket.remoteAddress || "unknown";
    const state: SocketState = {
      id: token(12),
      ip,
      socket: ws,
      roomId: null,
      role: null,
      lastSeen: now(),
    };
    states.set(ws, state);
    sockets.add(ws);

    ws.on("message", (data, isBinary) => {
      if (closing) return;
      state.lastSeen = now();
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (raw.byteLength > config.maxMessageBytes) {
        sendError(ws, "MESSAGE_TOO_LARGE");
        return;
      }
      if (!messageLimiter.allow(state.id)) {
        sendError(ws, "RATE_LIMITED");
        return;
      }
      if (isBinary) {
        sendError(ws, "INVALID_MESSAGE");
        return;
      }
      const parsedJson = parseJson(raw.toString("utf8"));
      if (parsedJson === null) {
        sendError(ws, "INVALID_MESSAGE");
        return;
      }
      let message: SignalingClientMessage;
      try {
        message = parseSignalingClientMessage(parsedJson);
      } catch {
        sendError(ws, "INVALID_MESSAGE");
        return;
      }
      try {
        dispatch(state, message);
      } catch {
        logger.error("message_failed", { code: "INTERNAL_ERROR" });
        sendError(ws, "INTERNAL_ERROR", message.transferId);
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      handleDisconnect(ws);
      states.delete(ws);
    });

    ws.on("error", () => {
      logger.warn("socket_error");
    });
  });

  async function listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (address && typeof address === "object") return address.port;
    return config.port;
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(sweepTimer);
    for (const room of rooms.values()) deleteRoom(room);
    for (const socket of sockets) {
      try {
        socket.close(1001, "server shutting down");
      } catch {
        /* already closed */
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close(() => resolve());
    });
  }

  return {
    config,
    httpServer,
    wss,
    get roomCount() {
      return rooms.size;
    },
    listen,
    close,
  };
}
