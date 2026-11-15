import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@shareshare/protocol";
import { createSignalingServer, type SignalingServerHandle } from "../src/server.js";
import type { SignalingConfig, Logger } from "../src/config.js";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const TRANSFER_ID = "signaling-test-1";
const ORIGIN = "http://test.local";

interface AnyMessage {
  type: string;
  [key: string]: unknown;
}

class Client {
  readonly ws: WebSocket;
  readonly messages: AnyMessage[] = [];
  #waiters: Array<{ predicate: (message: AnyMessage) => boolean; resolve: (m: AnyMessage) => void }> =
    [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as AnyMessage;
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.#waiters.splice(index, 1);
        waiter!.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  static connect(url: string, origin = ORIGIN): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin });
      ws.once("open", () => resolve(new Client(ws)));
      ws.once("error", reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, transferId: TRANSFER_ID, ...message }));
  }

  next(predicate: (message: AnyMessage) => boolean, timeoutMs = 3000): Promise<AnyMessage> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === wrapped);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error(`timed out waiting for message; got ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      const wrapped = (message: AnyMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push({ predicate, resolve: wrapped });
    });
  }

  byType(type: string, timeoutMs = 3000): Promise<AnyMessage> {
    return this.next((message) => message.type === type, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

const clients: Client[] = [];
const servers: SignalingServerHandle[] = [];

async function startServer(overrides: Partial<SignalingConfig> = {}) {
  const server = createSignalingServer({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [ORIGIN],
    roomTtlMs: 10_000,
    reconnectGraceMs: 500,
    heartbeatTimeoutMs: 10_000,
    maxMessageBytes: 64 * 1024,
    maxRooms: 100,
    maxMessagesPerMinute: 10_000,
    maxAttachAttemptsPerMinute: 10_000,
    sweepIntervalMs: 50,
    logger: silentLogger,
    ...overrides,
  });
  servers.push(server);
  const port = await server.listen();
  return { server, url: `ws://127.0.0.1:${port}/ws` };
}

async function connect(url: string): Promise<Client> {
  const client = await Client.connect(url);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
  for (const server of servers.splice(0)) await server.close();
});

function createRoom(client: Client, size = "1024") {
  client.send({
    type: "create-room",
    file: { name: "sample.bin", size, lastModified: 1_700_000_000_000, mime: "application/octet-stream" },
  });
  return client.byType("room-created");
}

async function approvedPair(url: string) {
  const sender = await connect(url);
  const receiver = await connect(url);
  const created = await createRoom(sender);
  receiver.send({
    type: "join-room",
    roomId: created.roomId,
    inviteToken: created.inviteToken,
  });
  const joined = await receiver.byType("joined");
  await sender.byType("peer-joined");
  sender.send({
    type: "approve-peer",
    connectionCode: created.connectionCode,
  });
  await sender.byType("peer-approved");
  await receiver.byType("peer-approved");
  return { sender, receiver, created, joined };
}

describe("signaling server", () => {
  it("creates a room, joins, approves, and relays SDP/ICE", async () => {
    const { url } = await startServer();
    const sender = await connect(url);
    const receiver = await connect(url);
    const created = await createRoom(sender);

    expect(created.roomId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(created.senderToken).not.toBe(created.inviteToken);
    expect(created.connectionCode).toMatch(/^[0-9]{6}$/);
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    receiver.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    const joined = await receiver.byType("joined");
    expect(joined.sessionToken).toBeTruthy();
    expect(joined.sessionToken).not.toBe(created.inviteToken);
    expect(joined.connectionCode).toBe(created.connectionCode);
    await sender.byType("peer-joined");

    // Relaying before approval must be refused.
    sender.send({ type: "offer", sdp: "v=0\r\n" });
    expect(await sender.byType("error")).toMatchObject({ code: "NOT_APPROVED" });

    sender.send({ type: "approve-peer", connectionCode: "000000" });
    expect(await sender.byType("error")).toMatchObject({ code: "BAD_CONNECTION_CODE" });

    sender.send({ type: "approve-peer", connectionCode: created.connectionCode });
    await sender.byType("peer-approved");
    await receiver.byType("peer-approved");

    sender.send({ type: "offer", sdp: "v=0\r\nfake-offer" });
    expect(await receiver.byType("offer")).toMatchObject({ sdp: "v=0\r\nfake-offer" });

    receiver.send({ type: "answer", sdp: "v=0\r\nfake-answer" });
    expect(await sender.byType("answer")).toMatchObject({ sdp: "v=0\r\nfake-answer" });

    receiver.send({ type: "ice-candidate", candidate: { candidate: "candidate:1", sdpMLineIndex: 0 } });
    expect(await sender.byType("ice-candidate")).toMatchObject({
      candidate: { candidate: "candidate:1" },
    });

    sender.send({ type: "ice-candidate", candidate: null });
    expect(await receiver.byType("ice-candidate")).toMatchObject({ candidate: null });
  });

  it("enforces token separation, room capacity, and one approved receiver", async () => {
    const { url } = await startServer();
    const sender = await connect(url);
    const receiver = await connect(url);
    const created = await createRoom(sender);

    receiver.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: "x".repeat(43),
    });
    expect(await receiver.byType("error")).toMatchObject({ code: "INVALID_CREDENTIAL" });

    receiver.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    await receiver.byType("joined");

    const extra = await connect(url);
    extra.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    expect(await extra.byType("error")).toMatchObject({ code: "ROOM_FULL" });

    const intruder = await connect(url);
    intruder.send({
      type: "resume-session",
      roomId: created.roomId,
      sessionToken: "y".repeat(43),
    });
    expect(await intruder.byType("error")).toMatchObject({ code: "INVALID_CREDENTIAL" });

    sender.send({ type: "approve-peer", connectionCode: created.connectionCode });
    await sender.byType("peer-approved");
    await receiver.byType("peer-approved");

    const late = await connect(url);
    late.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    expect(await late.byType("error")).toMatchObject({ code: "ALREADY_APPROVED" });
  });

  it("closes the room immediately when a peer explicitly leaves", async () => {
    const { server, url } = await startServer();
    const { sender, receiver } = await approvedPair(url);
    sender.send({ type: "leave-room" });
    expect(await receiver.byType("peer-left")).toMatchObject({ role: "sender", final: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.roomCount).toBe(0);
  });

  it("lets another receiver join after a pre-approval leave", async () => {
    const { server, url } = await startServer();
    const sender = await connect(url);
    const first = await connect(url);
    const created = await createRoom(sender);
    first.send({ type: "join-room", roomId: created.roomId, inviteToken: created.inviteToken });
    await first.byType("joined");
    await sender.byType("peer-joined");

    first.send({ type: "leave-room" });
    expect(await sender.byType("peer-left")).toMatchObject({ role: "receiver", final: true });
    expect(server.roomCount).toBe(1);

    const second = await connect(url);
    second.send({ type: "join-room", roomId: created.roomId, inviteToken: created.inviteToken });
    expect(await second.byType("joined")).toMatchObject({ type: "joined" });
    await sender.byType("peer-joined");
  });

  it("resumes an approved session and closes the room after the grace period", async () => {
    const { server, url } = await startServer({ reconnectGraceMs: 300 });
    const { sender, receiver, created, joined } = await approvedPair(url);

    receiver.close();
    expect(await sender.byType("peer-left")).toMatchObject({ role: "receiver", final: false });

    const resumedClient = await connect(url);
    resumedClient.send({
      type: "resume-session",
      roomId: created.roomId,
      sessionToken: joined.sessionToken,
    });
    const resumed = await resumedClient.byType("resumed");
    expect(resumed).toMatchObject({ role: "receiver", approved: true, peerPresent: true });
    expect(await sender.byType("peer-reconnected")).toMatchObject({ role: "receiver" });

    resumedClient.close();
    expect(await sender.byType("peer-left")).toMatchObject({ role: "receiver", final: false });
    expect(
      await sender.next(
        (message) => message.type === "peer-left" && message.final === true,
        3000,
      ),
    ).toMatchObject({ role: "receiver", final: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.roomCount).toBe(0);
  });

  it("expires idle rooms and notifies both peers", async () => {
    const { server, url } = await startServer({ roomTtlMs: 150, sweepIntervalMs: 20 });
    const sender = await connect(url);
    const created = await createRoom(sender);

    const receiver = await connect(url);
    receiver.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    await receiver.byType("joined");

    await sender.byType("room-expired", 3000);
    expect(server.roomCount).toBe(0);
  });

  it("acknowledges heartbeats and rejects oversized or malformed messages", async () => {
    const { url } = await startServer({ maxMessageBytes: 1024 });
    const client = await connect(url);

    client.send({ type: "heartbeat", nonce: "abc" });
    expect(await client.byType("heartbeat-ack")).toMatchObject({ type: "heartbeat-ack" });

    client.ws.send("x".repeat(2048));
    expect(await client.byType("error")).toMatchObject({ code: "MESSAGE_TOO_LARGE" });

    client.ws.send("not json");
    expect(await client.byType("error")).toMatchObject({ code: "INVALID_MESSAGE" });

    client.send({ type: "teleport" });
    expect(await client.byType("error")).toMatchObject({ code: "INVALID_MESSAGE" });
  });

  it("rejects connections from unknown origins", async () => {
    const { url } = await startServer();
    await expect(Client.connect(url, "http://evil.local")).rejects.toThrow(/403/);
  });

  it("rate limits room creation per client address", async () => {
    const { url } = await startServer({ maxAttachAttemptsPerMinute: 2 });
    const first = await connect(url);
    const second = await connect(url);
    const third = await connect(url);
    await createRoom(first);
    await createRoom(second);
    await third.send({
      type: "create-room",
      file: { name: "x", size: "1", lastModified: 0 },
    });
    expect(await third.byType("error")).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("issues short-lived TURN credentials when configured", async () => {
    const secret = "test-turn-secret-0123456789";
    const { url } = await startServer({
      turnUrls: ["turn:turn.example.test:3478?transport=udp"],
      turnSecret: secret,
      turnTtlSeconds: 120,
      turnRealm: "shareshare-test",
    });
    const sender = await connect(url);
    const created = await createRoom(sender);
    const turn = (created.iceServers as Array<{ urls: unknown; username?: string; credential?: string }>).find(
      (server) => String(server.urls).includes("turn:"),
    );

    expect(turn).toBeTruthy();
    expect(turn!.username).toMatch(/:shareshare-test$/);
    const expected = createHmac("sha1", secret).update(turn!.username!).digest("base64");
    expect(turn!.credential).toBe(expected);
    const expiresAt = Number(turn!.username!.split(":")[0]);
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 130);
  });

  it("requires approval from the sender only", async () => {
    const { url } = await startServer();
    const sender = await connect(url);
    const receiver = await connect(url);
    const created = await createRoom(sender);
    receiver.send({
      type: "join-room",
      roomId: created.roomId,
      inviteToken: created.inviteToken,
    });
    await receiver.byType("joined");
    receiver.send({ type: "approve-peer", connectionCode: created.connectionCode });
    expect(await receiver.byType("error")).toMatchObject({ code: "NOT_ROOM_OWNER" });
  });
});
