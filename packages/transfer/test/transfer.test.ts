import { describe, expect, it } from "vitest";
import {
  Receiver,
  Sender,
  TransferStateMachine,
  createSha256Hasher,
  type ReceiverEvent,
  type SenderEvent,
  type TransferLimits,
} from "../src/index.js";
import {
  BufferSource,
  Link,
  MemorySink,
  sha256Factory,
  waitUntil,
  type LinkHooks,
} from "./fakes.js";

const TRANSFER_ID = "test-transfer-1";

function pattern(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) data[index] = (index * 31 + 7) % 256;
  return data;
}

async function hashOf(data: Uint8Array): Promise<string> {
  const hasher = createSha256Hasher();
  if (data.byteLength > 0) hasher.update(data);
  return hasher.digestHex();
}

interface HarnessOptions {
  size: number;
  link?: Link;
  sinkDelayMs?: number;
  sinkFailAt?: bigint;
  limits?: Partial<TransferLimits>;
  autoAccept?: boolean;
}

function createHarness(options: HarnessOptions) {
  const data = pattern(options.size);
  const source = new BufferSource(data);
  const sink = new MemorySink(BigInt(options.size), {
    delayMs: options.sinkDelayMs,
    failAt: options.sinkFailAt,
  });
  const link = options.link ?? new Link();
  const senderEvents: SenderEvent[] = [];
  const receiverEvents: ReceiverEvent[] = [];
  let sender!: Sender;
  let receiver!: Receiver;

  receiver = new Receiver({
    transferId: TRANSFER_ID,
    transport: link.receiverTransport,
    hasherFactory: sha256Factory(),
    limits: options.limits,
    onEvent: (event) => {
      receiverEvents.push(event);
      if (event.type === "offer" && options.autoAccept !== false) {
        receiver.accept(sink);
      }
    },
  });

  sender = new Sender({
    transferId: TRANSFER_ID,
    source,
    file: {
      name: "test.bin",
      size: String(options.size),
      lastModified: 1_700_000_000_000,
      mime: "application/octet-stream",
    },
    transport: link.senderTransport,
    hasherFactory: sha256Factory(),
    limits: options.limits,
    onEvent: (event) => senderEvents.push(event),
  });

  link.bindSender({ control: (message) => sender.handleControl(message) });
  link.bindReceiver({
    control: (message) => receiver.handleControl(message),
    frame: (frame) => receiver.handleFrame(frame),
  });

  return { data, source, sink, link, sender, receiver, senderEvents, receiverEvents };
}

function failureOf(events: Array<SenderEvent | ReceiverEvent>) {
  return events.find((event) => event.type === "failed");
}

async function runToCompletion(harness: ReturnType<typeof createHarness>, timeoutMs = 15_000) {
  harness.sender.start();
  await waitUntil(
    () =>
      ["completed", "failed", "cancelled"].includes(harness.sender.state) &&
      ["completed", "failed", "cancelled"].includes(harness.receiver.state),
    timeoutMs,
  );
}

describe("transfer state machine", () => {
  it("allows the documented flow and rejects impossible transitions", () => {
    const state = new TransferStateMachine();
    state.transition("preparing");
    state.transition("waiting-peer");
    state.transition("awaiting-approval");
    state.transition("negotiating");
    state.transition("awaiting-accept");
    state.transition("transferring");
    state.transition("verifying");
    state.transition("completed");
    expect(() => state.transition("transferring")).toThrow(/invalid transfer state/);
  });

  it("rejects skipping verification", () => {
    const state = new TransferStateMachine();
    state.transition("preparing");
    state.transition("awaiting-accept");
    expect(() => state.transition("completed")).toThrow(/invalid transfer state/);
  });
});

describe("sender and receiver", () => {
  for (const size of [0, 1, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 1024 * 1024 + 7]) {
    it(`transfers ${size} bytes and verifies SHA-256`, async () => {
      const harness = createHarness({ size });
      await runToCompletion(harness);

      expect(failureOf(harness.senderEvents)).toBeUndefined();
      expect(failureOf(harness.receiverEvents)).toBeUndefined();
      expect(harness.sender.state).toBe("completed");
      expect(harness.receiver.state).toBe("completed");
      expect(harness.sink.bytes).toEqual(harness.data);
      expect(harness.sink.closed).toBe(true);

      const expected = await hashOf(harness.data);
      const senderCompleted = harness.senderEvents.find((event) => event.type === "completed");
      const receiverCompleted = harness.receiverEvents.find((event) => event.type === "completed");
      expect(senderCompleted).toMatchObject({ type: "completed", sha256: expected });
      expect(receiverCompleted).toMatchObject({ type: "completed", sha256: expected });
    });
  }

  it("fails instead of completing when the receive hash differs", async () => {
    const link = new Link({
      mutateFrame: (frame) => {
        frame[24] = frame[24]! ^ 0xff; // first payload byte (20-byte header + 4)
      },
    });
    const harness = createHarness({ size: 256 * 1024, link });
    await runToCompletion(harness);

    expect(harness.sender.state).toBe("failed");
    expect(harness.receiver.state).toBe("failed");
    expect(failureOf(harness.receiverEvents)).toMatchObject({ code: "HASH_MISMATCH" });
    expect(harness.sink.closed).toBe(false);
    expect(harness.sink.aborted).toBe(true);
  });

  it("rejects a gap instead of writing at the wrong offset", async () => {
    const link = new Link({ dropFrame: (frame) => frame === 3 });
    const harness = createHarness({ size: 512 * 1024, link });
    await runToCompletion(harness);

    expect(harness.receiver.state).toBe("failed");
    expect(failureOf(harness.receiverEvents)).toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(harness.sender.state).toBe("failed");
    expect(harness.sink.closed).toBe(false);
  });

  it("ignores duplicate frames and duplicate acknowledgements", async () => {
    let droppedAcks = 0;
    const link = new Link({
      duplicateFrame: (frame) => frame === 2 || frame === 5,
      dropControl: (message) => {
        if (message.type === "ack" && droppedAcks === 0) {
          droppedAcks += 1;
          return true;
        }
        return false;
      },
    });
    const harness = createHarness({ size: 512 * 1024, link });
    await runToCompletion(harness);

    expect(harness.sender.state).toBe("completed");
    expect(harness.receiver.state).toBe("completed");
    expect(harness.sink.bytes).toEqual(harness.data);
    expect(droppedAcks).toBe(1);
  });

  it("does not report completion when the destination write fails", async () => {
    const harness = createHarness({ size: 256 * 1024, sinkFailAt: 64n * 1024n });
    await runToCompletion(harness);

    expect(failureOf(harness.receiverEvents)).toMatchObject({ code: "SINK_WRITE_FAILED" });
    expect(harness.receiver.state).toBe("failed");
    expect(harness.sender.state).toBe("failed");
    expect(harness.sink.aborted).toBe(true);
  });

  it("retries finish when the verified response is lost", async () => {
    let dropped = 0;
    const link = new Link({
      dropControl: (message) => {
        if (message.type === "verified" && dropped === 0) {
          dropped += 1;
          return true;
        }
        return false;
      },
    });
    const harness = createHarness({
      size: 256 * 1024,
      link,
      limits: { verifyTimeoutMs: 40, verifyRetries: 2 },
    });
    await runToCompletion(harness);

    expect(dropped).toBe(1);
    expect(harness.sender.state).toBe("completed");
    expect(harness.receiver.state).toBe("completed");
    expect(harness.senderEvents.find((event) => event.type === "completed")).toBeTruthy();
  });

  it("fails verification instead of reporting completion after retries run out", async () => {
    const link = new Link({
      dropControl: (message) => message.type === "verified",
    });
    const harness = createHarness({
      size: 256 * 1024,
      link,
      limits: { verifyTimeoutMs: 40, verifyRetries: 1 },
    });
    await runToCompletion(harness);

    expect(failureOf(harness.senderEvents)).toMatchObject({ code: "VERIFY_TIMEOUT" });
    expect(harness.sender.state).toBe("failed");
    // The receiver did write and verify its bytes; only the acknowledgment is lost.
    expect(harness.receiver.state).toBe("completed");
    expect(harness.sink.closed).toBe(true);
  });

  it("keeps unacknowledged bytes under the configured bound", async () => {
    const harness = createHarness({
      size: 1024 * 1024,
      sinkDelayMs: 1,
      limits: {
        chunkBytes: 4096,
        maxUnackedBytes: 16 * 1024,
        ackIntervalBytes: 4096,
        highWaterBytes: 8 * 1024,
        progressIntervalMs: 10,
      },
    });
    let maxOutstanding = 0n;
    const sampler = setInterval(() => {
      const outstanding = harness.sender.sentBytes - harness.sender.ackedBytes;
      if (outstanding > maxOutstanding) maxOutstanding = outstanding;
    }, 1);
    try {
      await runToCompletion(harness);
    } finally {
      clearInterval(sampler);
    }
    expect(harness.sender.state).toBe("completed");
    expect(maxOutstanding).toBeLessThanOrEqual(16n * 1024n + 4096n);
  });

  it("cancels from the receiver without marking completion", async () => {
    const harness = createHarness({ size: 1024 * 1024, sinkDelayMs: 2 });
    harness.sender.start();
    await waitUntil(() => harness.receiver.contiguousBytes >= 64n * 1024n);
    await harness.receiver.cancel("USER_CANCELLED", "test cancel");
    await waitUntil(
      () => harness.receiver.state === "cancelled" && harness.sender.state === "failed",
    );

    expect(harness.sink.aborted).toBe(true);
    expect(failureOf(harness.senderEvents)).toMatchObject({ code: "CANCELLED_BY_PEER" });
    expect(harness.receiverEvents.some((event) => event.type === "completed")).toBe(false);
  });

  it("refuses an offer whose size differs from the source", async () => {
    const link = new Link();
    const source = new BufferSource(pattern(100));
    const sink = new MemorySink(100n);
    const events: SenderEvent[] = [];
    const receiver = new Receiver({
      transferId: TRANSFER_ID,
      transport: link.receiverTransport,
      hasherFactory: sha256Factory(),
      onEvent: (event) => {
        if (event.type === "offer") receiver.accept(sink);
      },
    });
    const sender = new Sender({
      transferId: TRANSFER_ID,
      source,
      file: { name: "x", size: "99", lastModified: 0 },
      transport: link.senderTransport,
      hasherFactory: sha256Factory(),
      onEvent: (event) => events.push(event),
    });
    link.bindSender({ control: (message) => sender.handleControl(message) });
    link.bindReceiver({
      control: (message) => receiver.handleControl(message),
      frame: (frame) => receiver.handleFrame(frame),
    });
    sender.start();
    await waitUntil(() => sender.state === "failed");
    expect(events.find((event) => event.type === "failed")).toMatchObject({
      code: "SIZE_MISMATCH",
    });
  });
});

describe("resume", () => {
  it("treats a send failure as a recoverable transport interruption", async () => {
    const link = new Link({ failSendAfter: 5 });
    const harness = createHarness({
      size: 512 * 1024,
      link,
      sinkDelayMs: 2,
      limits: {
        chunkBytes: 16 * 1024,
        maxUnackedBytes: 64 * 1024,
        ackIntervalBytes: 16 * 1024,
        highWaterBytes: 32 * 1024,
      },
    });
    harness.sender.start();
    await waitUntil(() => harness.senderEvents.some((event) => event.type === "transport-lost"));
    expect(harness.sender.state).not.toBe("failed");
    expect(harness.sender.state).toBe("reconnecting");

    link.unlink();
    harness.sender.pause();
    const second = new Link();
    harness.sender.setTransport(second.senderTransport);
    harness.receiver.setTransport(second.receiverTransport);
    second.bindSender({ control: (message) => harness.sender.handleControl(message) });
    second.bindReceiver({
      control: (message) => harness.receiver.handleControl(message),
      frame: (frame) => harness.receiver.handleFrame(frame),
    });
    await harness.receiver.prepareResume();

    await waitUntil(
      () => harness.sender.state === "completed" && harness.receiver.state === "completed",
      20_000,
    );
    expect(harness.sink.bytes).toEqual(harness.data);
    expect(failureOf(harness.senderEvents)).toBeUndefined();
  });

  it("resumes from the receiver's confirmed offset with a matching hash", async () => {
    const harness = createHarness({
      size: 2 * 1024 * 1024,
      sinkDelayMs: 2,
      limits: {
        chunkBytes: 16 * 1024,
        maxUnackedBytes: 64 * 1024,
        ackIntervalBytes: 16 * 1024,
        highWaterBytes: 32 * 1024,
      },
    });
    harness.sender.start();

    await waitUntil(() => harness.receiver.contiguousBytes >= 256n * 1024n);
    harness.link.unlink();
    harness.sender.pause();
    const oldOffset = harness.receiver.contiguousBytes;
    expect(oldOffset).toBeGreaterThan(0n);

    const second = new Link();
    harness.sender.setTransport(second.senderTransport);
    harness.receiver.setTransport(second.receiverTransport);
    second.bindSender({ control: (message) => harness.sender.handleControl(message) });
    second.bindReceiver({
      control: (message) => harness.receiver.handleControl(message),
      frame: (frame) => harness.receiver.handleFrame(frame),
    });

    const resumeOffset = await harness.receiver.prepareResume();
    expect(resumeOffset).not.toBeNull();
    expect(resumeOffset!).toBeGreaterThanOrEqual(oldOffset);
    expect(resumeOffset!).toBe(harness.receiver.contiguousBytes);

    await waitUntil(
      () => harness.sender.state === "completed" && harness.receiver.state === "completed",
      20_000,
    );

    expect(harness.sink.bytes).toEqual(harness.data);
    const expected = await hashOf(harness.data);
    expect(harness.receiverEvents.find((event) => event.type === "completed")).toMatchObject({
      sha256: expected,
    });
    expect(harness.senderEvents.find((event) => event.type === "completed")).toMatchObject({
      sha256: expected,
    });
    expect(harness.senderEvents.some((event) => event.type === "resuming")).toBe(true);
  });

  it("fails clearly when the source changes between resume attempts", async () => {
    const data = pattern(2 * 1024 * 1024);
    const source = new BufferSource(data);
    const sink = new MemorySink(BigInt(data.byteLength), { delayMs: 2 });
    const first = new Link();
    const senderEvents: SenderEvent[] = [];
    const receiverEvents: ReceiverEvent[] = [];
    let sender!: Sender;
    let receiver!: Receiver;

    receiver = new Receiver({
      transferId: TRANSFER_ID,
      transport: first.receiverTransport,
      hasherFactory: sha256Factory(),
      onEvent: (event) => {
        receiverEvents.push(event);
        if (event.type === "offer") receiver.accept(sink);
      },
    });
    sender = new Sender({
      transferId: TRANSFER_ID,
      source,
      file: { name: "x.bin", size: String(data.byteLength), lastModified: 0 },
      transport: first.senderTransport,
      hasherFactory: sha256Factory(),
      onEvent: (event) => senderEvents.push(event),
      limits: {
        chunkBytes: 4096,
        maxUnackedBytes: 32 * 1024,
        ackIntervalBytes: 4096,
        highWaterBytes: 16 * 1024,
      },
    });
    first.bindSender({ control: (message) => sender.handleControl(message) });
    first.bindReceiver({
      control: (message) => receiver.handleControl(message),
      frame: (frame) => receiver.handleFrame(frame),
    });

    sender.start();
    await waitUntil(() => receiver.contiguousBytes >= 64n * 1024n);
    first.unlink();
    sender.pause();
    // Simulate an in-place source edit: existing bytes now hash differently.
    data[1000] = data[1000]! ^ 0xff;

    const second = new Link();
    sender.setTransport(second.senderTransport);
    receiver.setTransport(second.receiverTransport);
    second.bindSender({ control: (message) => sender.handleControl(message) });
    second.bindReceiver({
      control: (message) => receiver.handleControl(message),
      frame: (frame) => receiver.handleFrame(frame),
    });
    await receiver.prepareResume();

    await waitUntil(
      () =>
        ["completed", "failed"].includes(sender.state) &&
        ["completed", "failed"].includes(receiver.state),
      20_000,
    );
    expect(receiver.state).toBe("failed");
    expect(receiverEvents.find((event) => event.type === "failed")).toMatchObject({
      code: "HASH_MISMATCH",
    });
    expect(sender.state).toBe("failed");
    expect(sink.closed).toBe(false);
  });
});
