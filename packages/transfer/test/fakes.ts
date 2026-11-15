import type { DataMessage } from "@shareshare/protocol";
import type {
  ChunkSink,
  ChunkSource,
  Clock,
  ControlTransport,
  Hasher,
  HasherFactory,
} from "../src/index.js";
import { createSha256Hasher } from "../src/index.js";

export class FakeClock implements Clock {
  #now = 1_000_000;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          next = { id, at: timer.at, callback: timer.callback };
        }
      }
      if (!next) break;
      this.#timers.delete(next.id);
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }
}

export class BufferSource implements ChunkSource {
  readonly data: Uint8Array;
  readonly size: bigint;
  reads = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.size = BigInt(data.byteLength);
  }

  async read(position: bigint, length: number): Promise<Uint8Array> {
    this.reads += 1;
    const start = Number(position);
    return this.data.slice(start, start + length);
  }
}

export class MemorySink implements ChunkSink {
  readonly size: bigint;
  readonly bytes: Uint8Array;
  readonly writes: Array<{ position: bigint; length: number }> = [];
  readonly maxWritten = { value: 0n };
  closed = false;
  aborted = false;
  abortReason: string | null = null;
  #delayMs: number;
  #failAt: bigint | null;

  constructor(size: bigint, options: { delayMs?: number; failAt?: bigint } = {}) {
    this.size = size;
    this.bytes = new Uint8Array(Number(size));
    this.#delayMs = options.delayMs ?? 0;
    this.#failAt = options.failAt ?? null;
  }

  async write(position: bigint, data: Uint8Array): Promise<void> {
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    if (this.#failAt !== null && position >= this.#failAt) {
      throw new Error("simulated disk failure");
    }
    if (this.aborted || this.closed) throw new Error("sink is closed");
    this.bytes.set(data, Number(position));
    this.writes.push({ position, length: data.byteLength });
    if (position + BigInt(data.byteLength) > this.maxWritten.value) {
      this.maxWritten.value = position + BigInt(data.byteLength);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(reason: string): Promise<void> {
    this.aborted = true;
    this.abortReason = reason;
  }
}

export function sha256Factory(): HasherFactory {
  return () => createSha256Hasher();
}

export interface LinkHooks {
  maxMessageSize?: number;
  dropControl?: (message: DataMessage, direction: "s2r" | "r2s") => boolean;
  dropFrame?: (frameNumber: number, direction: "s2r" | "r2s") => boolean;
  duplicateFrame?: (frameNumber: number) => boolean;
  mutateFrame?: (payload: Uint8Array) => void;
  failSendAfter?: number;
  deliveryDelayMs?: number;
}

type Endpoint = "sender" | "receiver";

export class Link {
  readonly hooks: LinkHooks;
  frameCount = 0;
  linked = true;
  #sender: LinkEndpoint;
  #receiver: LinkEndpoint;

  constructor(hooks: LinkHooks = {}) {
    this.hooks = hooks;
    this.#sender = new LinkEndpoint(this, "sender");
    this.#receiver = new LinkEndpoint(this, "receiver");
    this.#sender.peer = this.#receiver;
    this.#receiver.peer = this.#sender;
  }

  get senderTransport(): ControlTransport {
    return this.#sender;
  }

  get receiverTransport(): ControlTransport {
    return this.#receiver;
  }

  bindSender(handlers: {
    control: (message: DataMessage) => void;
    frame?: (frame: Uint8Array) => void;
  }): void {
    this.#sender.controlHandler = handlers.control;
    this.#sender.frameHandler = handlers.frame ?? null;
  }

  bindReceiver(handlers: {
    control: (message: DataMessage) => void;
    frame?: (frame: Uint8Array) => void;
  }): void {
    this.#receiver.controlHandler = handlers.control;
    this.#receiver.frameHandler = handlers.frame ?? null;
  }

  unlink(): void {
    this.linked = false;
  }

  deliverControl(from: Endpoint, message: DataMessage): void {
    if (!this.linked) return;
    const direction = from === "sender" ? "s2r" : "r2s";
    if (this.hooks.dropControl?.(message, direction)) return;
    const target = from === "sender" ? this.#receiver : this.#sender;
    schedule(() => {
      if (!this.linked) return;
      target.controlHandler?.(structuredClone(message));
    }, this.hooks.deliveryDelayMs ?? 0);
  }

  deliverFrame(from: Endpoint, frame: Uint8Array): void {
    if (!this.linked) return;
    this.frameCount += 1;
    const frameNumber = this.frameCount;
    if (this.hooks.dropFrame?.(frameNumber, from === "sender" ? "s2r" : "r2s")) return;
    const copy = frame.slice();
    if (this.hooks.mutateFrame) this.hooks.mutateFrame(copy);
    const target = from === "sender" ? this.#receiver : this.#sender;
    schedule(() => {
      if (!this.linked) return;
      target.frameHandler?.(copy);
    }, this.hooks.deliveryDelayMs ?? 0);
    if (this.hooks.duplicateFrame?.(frameNumber)) {
      const duplicate = frame.slice();
      schedule(() => {
        if (!this.linked) return;
        target.frameHandler?.(duplicate);
      }, (this.hooks.deliveryDelayMs ?? 0) + 1);
    }
  }
}

function schedule(callback: () => void, delayMs: number): void {
  if (delayMs > 0) setTimeout(callback, delayMs);
  else queueMicrotask(callback);
}

class LinkEndpoint implements ControlTransport {
  readonly href: Link;
  readonly endpoint: Endpoint;
  peer: LinkEndpoint | null = null;
  controlHandler: ((message: DataMessage) => void) | null = null;
  frameHandler: ((frame: Uint8Array) => void) | null = null;
  #drainListeners = new Set<() => void>();
  #sentFrames = 0;

  constructor(href: Link, endpoint: Endpoint) {
    this.href = href;
    this.endpoint = endpoint;
  }

  sendControl(message: DataMessage): void {
    if (!this.href.linked) throw new Error("link is closed");
    this.href.deliverControl(this.endpoint, message);
  }

  sendFrame(frame: Uint8Array): void {
    if (!this.href.linked) throw new Error("link is closed");
    this.#sentFrames += 1;
    if (
      this.endpoint === "sender" &&
      this.href.hooks.failSendAfter !== undefined &&
      this.#sentFrames > this.href.hooks.failSendAfter
    ) {
      throw new Error("simulated transport failure");
    }
    this.href.deliverFrame(this.endpoint, frame);
  }

  bufferedAmount(): number {
    return 0;
  }

  maxMessageSize(): number {
    return this.href.hooks.maxMessageSize ?? 65536;
  }

  onDrain(listener: () => void): () => void {
    this.#drainListeners.add(listener);
    return () => this.#drainListeners.delete(listener);
  }

  fireDrain(): void {
    for (const listener of this.#drainListeners) listener();
  }
}

export class HashRecorder implements Hasher {
  readonly inner = createSha256Hasher();
  updates = 0;

  update(data: Uint8Array): void {
    this.updates += 1;
    this.inner.update(data);
  }

  digestHex(): Promise<string> {
    return this.inner.digestHex();
  }
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 2,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
