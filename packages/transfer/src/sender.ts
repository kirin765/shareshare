import {
  HEADER_BYTES,
  MIN_DATACHANNEL_MESSAGE_BYTES,
  encodeDataFrame,
  type DataMessage,
  type FileMetadata,
} from "@shareshare/protocol";
import { RateMeter } from "./rate.js";
import { TransferStateMachine, TransferStateError } from "./state-machine.js";
import {
  DEFAULT_LIMITS,
  systemClock,
  type Clock,
  type ControlTransport,
  type Hasher,
  type SenderEvent,
  type SenderOptions,
  type TransferFailureCode,
  type TransferLimits,
  type TransferState,
} from "./types.js";

export class TransportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportLimitError";
  }
}

export function resolveChunkBytes(limits: TransferLimits, maxMessageSize: number): number {
  if (!Number.isFinite(maxMessageSize) || maxMessageSize < MIN_DATACHANNEL_MESSAGE_BYTES) {
    throw new TransportLimitError(
      `DataChannel message limit ${maxMessageSize} is below the supported minimum`,
    );
  }
  const available = maxMessageSize - HEADER_BYTES;
  const chunk = Math.min(limits.chunkBytes, available);
  if (chunk < 1024) throw new TransportLimitError("negotiated chunk size is too small");
  return chunk;
}

function normalizeLimits(overrides: Partial<TransferLimits> | undefined): TransferLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!Number.isInteger(limits.chunkBytes) || limits.chunkBytes <= 0) {
    throw new TransportLimitError("chunkBytes must be a positive integer");
  }
  if (limits.maxUnackedBytes < limits.chunkBytes) {
    throw new TransportLimitError("maxUnackedBytes must be at least one chunk");
  }
  if (limits.ackIntervalBytes <= 0 || limits.progressIntervalMs <= 0) {
    throw new TransportLimitError("invalid transfer limit");
  }
  return limits;
}

export class Sender {
  readonly transferId: string;
  readonly #source: SenderOptions["source"];
  readonly #file: FileMetadata;
  readonly #totalBytes: bigint;
  readonly #hasherFactory: SenderOptions["hasherFactory"];
  readonly #limits: TransferLimits;
  readonly #clock: Clock;
  readonly #onEvent: (event: SenderEvent) => void;
  readonly #stateMachine = new TransferStateMachine("preparing");
  readonly #meter: RateMeter;

  #transport: ControlTransport;
  #unsubscribeDrain: () => void;
  #hasher: Hasher;
  #chunkBytes: number;

  #started = false;
  #accepted = false;
  #paused = false;
  #stopped = false;
  #pumpRunning = false;
  #pumpIdleWaiters: Array<() => void> = [];
  #spaceWaiters: Array<() => void> = [];

  #sentOffset = 0n;
  #ackedOffset = 0n;
  #hashedOffset = 0n;
  #startOffset = 0n;
  #sequence = 0;
  #sentFrames = 0;
  #lastProgressAt = 0;
  #digest: string | null = null;
  #verifyTimer: unknown = null;
  #verifyAttempts = 0;
  #finishMessage: Extract<DataMessage, { type: "finish" }> | null = null;

  constructor(options: SenderOptions) {
    this.transferId = options.transferId;
    this.#source = options.source;
    this.#file = options.file;
    this.#totalBytes = BigInt(options.file.size);
    this.#hasherFactory = options.hasherFactory;
    this.#limits = normalizeLimits(options.limits);
    this.#clock = options.clock ?? systemClock;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#meter = new RateMeter(this.#clock);
    this.#transport = options.transport;
    this.#chunkBytes = resolveChunkBytes(this.#limits, this.#transport.maxMessageSize());
    this.#hasher = this.#hasherFactory();
    this.#unsubscribeDrain = this.#transport.onDrain(() => this.#notifySpace());
  }

  get state(): TransferState {
    return this.#stateMachine.state;
  }

  get chunkBytes(): number {
    return this.#chunkBytes;
  }

  get sentBytes(): bigint {
    return this.#sentOffset;
  }

  get ackedBytes(): bigint {
    return this.#ackedOffset;
  }

  /** Move the UI-level phase before a room peer has joined. */
  markWaitingForPeer(): void {
    this.#transition("waiting-peer");
  }

  markAwaitingApproval(): void {
    this.#transition("awaiting-approval");
  }

  beginNegotiation(): void {
    this.#transition("negotiating");
  }

  /** Send the file offer and wait for accept/ready. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (this.#source.size !== this.#totalBytes) {
      this.#fail("SIZE_MISMATCH", "source size does not match the offered size");
      return;
    }
    try {
      this.#transition("awaiting-accept");
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#sendControl({
      protocolVersion: 1,
      transferId: this.transferId,
      type: "file-offer",
      file: this.#file,
    });
    this.#emit({ type: "offer-sent", file: this.#file });
  }

  get started(): boolean {
    return this.#started;
  }

  /** Repeat the offer after a channel replacement before the receiver accepted. */
  resendOffer(): void {
    if (!this.#started || this.#stopped || this.#accepted) return;
    if (this.#stateMachine.state !== "awaiting-accept") return;
    this.#sendControl({
      protocolVersion: 1,
      transferId: this.transferId,
      type: "file-offer",
      file: this.#file,
    });
  }

  setTransport(transport: ControlTransport): void {
    this.#unsubscribeDrain();
    this.#transport = transport;
    this.#unsubscribeDrain = transport.onDrain(() => this.#notifySpace());
    this.#chunkBytes = resolveChunkBytes(this.#limits, transport.maxMessageSize());
  }

  /** Called when the peer connection drops. Keeps hash and offsets for resume. */
  pause(): void {
    if (this.#stopped || this.#paused) return;
    if (this.#stateMachine.state === "transferring") {
      this.#paused = true;
      this.#notifySpace();
      try {
        this.#transition("reconnecting");
      } catch (error) {
        this.#failFrom(error);
      }
    } else {
      this.#paused = true;
      this.#notifySpace();
    }
  }

  /**
   * Resume at the receiver's confirmed offset after a new DataChannel exists.
   * The sender re-hashes the prefix because incremental SHA-256 state cannot be
   * rewound; this preserves the "hash only contiguous sent bytes" invariant.
   */
  async resumeFrom(offset: bigint): Promise<void> {
    if (this.#stopped) return;
    if (offset > this.#totalBytes) {
      this.#fail("RESUME_REJECTED", "resume offset exceeds the file size");
      return;
    }
    if (offset > this.#sentOffset) {
      this.#fail("RESUME_REJECTED", "resume offset is ahead of sent bytes");
      return;
    }
    this.pause();
    await this.#waitUntilIdle();
    if (this.#stopped) return;

    const ok = await this.#rehashPrefix(offset);
    if (!ok || this.#stopped) return;

    this.#sentOffset = offset;
    this.#ackedOffset = offset;
    this.#hashedOffset = offset;
    this.#startOffset = offset;
    this.#sequence = 0;
    this.#sentFrames = 0;
    this.#verifyAttempts = 0;
    this.#paused = false;
    try {
      this.#transition("transferring");
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#sendControl({
      protocolVersion: 1,
      transferId: this.transferId,
      type: "resume-ready",
      offset: offset.toString(10),
    });
    this.#emit({ type: "resuming", offset });
    this.#notifySpace();
    this.#emitProgress(true);
    void this.#runPump();
  }

  handleControl(message: DataMessage): void {
    if (this.#stopped) return;
    if (message.transferId !== this.transferId) {
      this.#fail("PROTOCOL_ERROR", "control message belongs to another transfer");
      return;
    }
    try {
      switch (message.type) {
        case "accept":
          this.#accepted = true;
          break;
        case "reject":
          this.#fail("REJECTED", message.reason ?? "receiver rejected the file");
          break;
        case "ready":
          this.#handleReady(BigInt(message.offset));
          break;
        case "ack":
          this.#handleAck(BigInt(message.offset));
          break;
        case "verified":
          this.#handleVerified(message.sha256);
          break;
        case "cancel":
          this.#fail("CANCELLED_BY_PEER", message.message ?? `peer cancelled: ${message.code}`);
          break;
        case "error":
          this.#fail(
            message.code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "PROTOCOL_ERROR",
            message.message ?? `peer error: ${message.code}`,
          );
          break;
        case "resume-request": {
          const offset = BigInt(message.offset);
          const state = this.#stateMachine.state;
          if (state === "verifying" || state === "completed") {
            if (offset === this.#totalBytes && this.#finishMessage) {
              this.#sendControl({
                protocolVersion: 1,
                transferId: this.transferId,
                type: "resume-ready",
                offset: offset.toString(10),
              });
              this.#sendControl(this.#finishMessage);
              this.#emit({ type: "resuming", offset });
            } else {
              this.#fail(
                "RESUME_REJECTED",
                "cannot rewind after the sender started final verification",
              );
            }
            break;
          }
          void this.resumeFrom(offset);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.#failFrom(error);
    }
  }

  cancel(code = "USER_CANCELLED", message = "sender cancelled"): void {
    if (this.#stopped) return;
    this.#sendControlBestEffort({
      protocolVersion: 1,
      transferId: this.transferId,
      type: "cancel",
      code,
      message,
      partialBytes: this.#sentOffset.toString(10),
    });
    this.#stop();
    try {
      this.#transition("cancelled");
    } catch {
      /* terminal state already */
    }
    this.#emit({ type: "cancelled", code });
  }

  dispose(): void {
    this.#stop();
    this.#unsubscribeDrain();
  }

  #handleReady(offset: bigint): void {
    if (!this.#accepted) {
      this.#fail("PROTOCOL_ERROR", "ready arrived before accept");
      return;
    }
    if (offset > this.#totalBytes) {
      this.#fail("PROTOCOL_ERROR", "ready offset exceeds the file size");
      return;
    }
    const state = this.#stateMachine.state;
    if (state === "transferring" || state === "reconnecting") {
      if (offset === this.#startOffset) return;
      this.#fail("PROTOCOL_ERROR", "duplicate ready with a different offset");
      return;
    }
    if (state === "verifying" || state === "completed") return;
    if (state !== "awaiting-accept" && state !== "negotiating") {
      this.#fail("PROTOCOL_ERROR", `ready is not valid in state ${state}`);
      return;
    }
    void this.#beginTransfer(offset);
  }

  async #beginTransfer(offset: bigint): Promise<void> {
    try {
      this.#transition("transferring");
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#sentOffset = offset;
    this.#ackedOffset = offset;
    this.#startOffset = offset;
    this.#sequence = 0;
    this.#sentFrames = 0;
    this.#paused = false;
    this.#lastProgressAt = 0;
    this.#emitProgress(true);
    void this.#runPump();
  }

  async #runPump(): Promise<void> {
    if (this.#pumpRunning || this.#stopped) return;
    this.#pumpRunning = true;
    try {
      while (!this.#stopped && !this.#paused) {
        if (this.#sentOffset >= this.#totalBytes) {
          await this.#finishSending();
          break;
        }
        if (!this.#hasSpace()) {
          const result = await this.#waitForSpace();
          if (result === "timeout" && !this.#paused && !this.#stopped) {
            this.#fail("ACK_TIMEOUT", "timed out waiting for receiver acknowledgements");
          }
          continue;
        }

        const remaining = this.#totalBytes - this.#sentOffset;
        const length = Number(remaining < BigInt(this.#chunkBytes) ? remaining : BigInt(this.#chunkBytes));
        const offset = this.#sentOffset;
        let data: Uint8Array;
        try {
          data = await this.#source.read(offset, length);
        } catch {
          this.#fail("SOURCE_READ_FAILED", "could not read the source file");
          break;
        }
        if (this.#stopped) break;
        if (this.#paused) break;
        if (data.byteLength !== length) {
          this.#fail("SOURCE_CHANGED", "source file changed or was truncated");
          break;
        }

        const encoded = encodeDataFrame({
          sequence: this.#sequence,
          offset,
          payload: data,
        });
        if (!this.#sendFrame(encoded)) break;
        this.#hasher.update(data);
        this.#sentOffset += BigInt(length);
        this.#hashedOffset = this.#sentOffset;
        this.#sequence += 1;
        this.#sentFrames += 1;
        this.#emitProgress(false);
      }
    } catch (error) {
      if (!this.#paused && !this.#stopped) {
        this.#fail("TRANSPORT_ERROR", error instanceof Error ? error.message : "send failed");
      }
    } finally {
      this.#pumpRunning = false;
      const waiters = this.#pumpIdleWaiters;
      this.#pumpIdleWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  async #finishSending(): Promise<void> {
    if (this.#stopped) return;
    let digest: string;
    try {
      digest = await this.#hasher.digestHex();
    } catch {
      this.#fail("SOURCE_READ_FAILED", "could not finalize the source hash");
      return;
    }
    if (this.#stopped) return;
    this.#digest = digest;
    try {
      this.#transition("verifying");
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#finishMessage = {
      protocolVersion: 1,
      transferId: this.transferId,
      type: "finish",
      totalBytes: this.#sentOffset.toString(10),
      totalChunks: this.#sentFrames,
      sha256: digest,
    };
    this.#sendControl(this.#finishMessage);
    this.#emitProgress(true);
    this.#scheduleVerifyRetry();
  }

  #scheduleVerifyRetry(): void {
    this.#clearVerifyTimer();
    this.#verifyTimer = this.#clock.setTimeout(() => {
      if (this.#stopped || this.#stateMachine.state !== "verifying" || !this.#finishMessage) return;
      this.#verifyAttempts += 1;
      if (this.#verifyAttempts > this.#limits.verifyRetries) {
        this.#fail("VERIFY_TIMEOUT", "receiver did not confirm verification");
        return;
      }
      this.#sendControl(this.#finishMessage);
      this.#scheduleVerifyRetry();
    }, this.#limits.verifyTimeoutMs);
  }

  #clearVerifyTimer(): void {
    if (this.#verifyTimer !== null) {
      this.#clock.clearTimeout(this.#verifyTimer);
      this.#verifyTimer = null;
    }
  }

  #handleAck(offset: bigint): void {
    if (offset > this.#sentOffset) {
      this.#fail("PROTOCOL_ERROR", "acknowledgement is ahead of sent bytes");
      return;
    }
    if (offset > this.#ackedOffset) {
      this.#ackedOffset = offset;
      this.#notifySpace();
      this.#emitProgress(false);
    }
  }

  #handleVerified(sha256: string): void {
    if (this.#stateMachine.state === "completed") return;
    if (this.#stateMachine.state !== "verifying") {
      this.#fail("PROTOCOL_ERROR", "verified arrived before verification started");
      return;
    }
    if (this.#digest !== null && sha256 !== this.#digest) {
      this.#fail("HASH_MISMATCH", "receiver verified a different hash");
      return;
    }
    this.#clearVerifyTimer();
    try {
      this.#transition("completed");
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#stop();
    this.#emit({ type: "completed", sha256 });
  }

  async #rehashPrefix(offset: bigint): Promise<boolean> {
    const hasher = this.#hasherFactory();
    const rehashChunk = 1024 * 1024;
    let position = 0n;
    while (position < offset) {
      if (this.#stopped) return false;
      const remaining = offset - position;
      const length = Number(remaining < BigInt(rehashChunk) ? remaining : BigInt(rehashChunk));
      let data: Uint8Array;
      try {
        data = await this.#source.read(position, length);
      } catch {
        this.#fail("SOURCE_READ_FAILED", "could not read the source while resuming");
        return false;
      }
      if (this.#stopped) return false;
      if (data.byteLength !== length) {
        this.#fail("SOURCE_CHANGED", "source file changed while resuming");
        return false;
      }
      hasher.update(data);
      position += BigInt(length);
    }
    this.#hasher = hasher;
    this.#hashedOffset = offset;
    return true;
  }

  #hasSpace(): boolean {
    const unacked = this.#sentOffset - this.#ackedOffset;
    return (
      unacked < BigInt(this.#limits.maxUnackedBytes) &&
      this.#transport.bufferedAmount() < this.#limits.highWaterBytes
    );
  }

  #waitForSpace(): Promise<"space" | "timeout"> {
    if (this.#hasSpace()) return Promise.resolve("space");
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = (result: "space" | "timeout") => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clock.clearTimeout(timer);
        const index = this.#spaceWaiters.indexOf(wake);
        if (index >= 0) this.#spaceWaiters.splice(index, 1);
        resolve(result);
      };
      const wake = () => finish("space");
      this.#spaceWaiters.push(wake);
      timer = this.#clock.setTimeout(() => finish("timeout"), this.#limits.stallTimeoutMs);
    });
  }

  #waitUntilIdle(): Promise<void> {
    if (!this.#pumpRunning) return Promise.resolve();
    return new Promise((resolve) => {
      this.#pumpIdleWaiters.push(resolve);
    });
  }

  #notifySpace(): void {
    const waiters = this.#spaceWaiters;
    this.#spaceWaiters = [];
    for (const wake of waiters) wake();
  }

  #emitProgress(force: boolean): void {
    const now = this.#clock.now();
    if (!force && now - this.#lastProgressAt < this.#limits.progressIntervalMs) return;
    this.#lastProgressAt = now;
    this.#meter.record(this.#sentOffset);
    const remaining = this.#totalBytes - this.#ackedOffset;
    const { bytesPerSecond, etaMs } = this.#meter.sample(remaining);
    this.#emit({
      type: "progress",
      sentBytes: this.#sentOffset,
      ackedBytes: this.#ackedOffset,
      totalBytes: this.#totalBytes,
      bytesPerSecond,
      etaMs,
    });
  }

  #sendFrame(frame: Uint8Array): boolean {
    try {
      this.#transport.sendFrame(frame);
      return true;
    } catch {
      this.#noteTransportLost("could not send a data frame");
      return false;
    }
  }

  #sendControl(message: DataMessage): void {
    if (this.#stopped) return;
    try {
      this.#transport.sendControl(message);
    } catch {
      this.#noteTransportLost("could not send a control message");
    }
  }

  /**
   * A send failure is treated as a transport interruption, not a terminal
   * error: the application reconnects and the receiver's offset drives resume.
   */
  #noteTransportLost(message: string): void {
    if (this.#stopped) return;
    this.#paused = true;
    this.#notifySpace();
    if (this.#stateMachine.state === "transferring") {
      try {
        this.#transition("reconnecting");
      } catch {
        /* state changed concurrently */
      }
    }
    this.#emit({ type: "transport-lost", message });
  }

  #sendControlBestEffort(message: DataMessage): void {
    try {
      this.#transport.sendControl(message);
    } catch {
      /* peer is already gone */
    }
  }

  #transition(next: TransferState): void {
    try {
      this.#stateMachine.transition(next);
      this.#emit({ type: "state", state: next });
    } catch (error) {
      if (error instanceof TransferStateError && error.from === error.to) return;
      throw error;
    }
  }

  #failFrom(error: unknown): void {
    if (error instanceof TransferStateError) {
      this.#fail("INVALID_STATE", error.message);
      return;
    }
    this.#fail("PROTOCOL_ERROR", error instanceof Error ? error.message : "unexpected error");
  }

  #fail(code: TransferFailureCode, message: string): void {
    if (this.#stopped) return;
    this.#sendControlBestEffort({
      protocolVersion: 1,
      transferId: this.transferId,
      type: "cancel",
      code,
      message: message.slice(0, 300),
      partialBytes: this.#sentOffset.toString(10),
    });
    this.#stop();
    try {
      this.#transition("failed");
    } catch {
      /* already terminal */
    }
    this.#emit({
      type: "failed",
      code,
      message,
      partialBytes: this.#sentOffset,
    });
  }

  #stop(): void {
    this.#stopped = true;
    this.#clearVerifyTimer();
    this.#notifySpace();
    const idle = this.#pumpIdleWaiters;
    this.#pumpIdleWaiters = [];
    for (const wake of idle) wake();
  }

  #emit(event: SenderEvent): void {
    try {
      this.#onEvent(event);
    } catch {
      /* UI callbacks must not break the transfer */
    }
  }
}
