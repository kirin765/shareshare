import {
  FrameError,
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  decodeDataFrame,
  type DataMessage,
  type FileMetadata,
  type FinishMessage,
} from "@shareshare/protocol";
import { RateMeter } from "./rate.js";
import { resolveChunkBytes } from "./sender.js";
import { TransferStateMachine, TransferStateError } from "./state-machine.js";
import {
  DEFAULT_LIMITS,
  systemClock,
  type Clock,
  type ChunkSink,
  type ControlTransport,
  type Hasher,
  type ReceiverEvent,
  type ReceiverOptions,
  type TransferFailureCode,
  type TransferLimits,
  type TransferState,
} from "./types.js";

const MAX_QUEUED_BYTES_FACTOR = 3;

export class Receiver {
  readonly transferId: string;
  readonly #hasherFactory: ReceiverOptions["hasherFactory"];
  readonly #limits: TransferLimits;
  readonly #clock: Clock;
  readonly #onEvent: (event: ReceiverEvent) => void;
  readonly #stateMachine = new TransferStateMachine("preparing");
  readonly #meter: RateMeter;
  readonly #maxFileBytes: bigint;

  #transport: ControlTransport;
  #chunkBytes: number;
  #hasher: Hasher | null = null;
  #sink: ChunkSink | null = null;
  #file: FileMetadata | null = null;
  #totalBytes = 0n;

  #expectedOffset = 0n;
  #contiguousOffset = 0n;
  #lastAckedOffset = 0n;
  #lastAckAt = 0;
  #queuedBytes = 0;
  #writtenFrames = 0;
  #generation = 0;
  #writeChain: Promise<void> = Promise.resolve();
  #lastProgressAt = 0;

  #stopped = false;
  #finishing = false;
  #closed = false;

  constructor(options: ReceiverOptions) {
    this.transferId = options.transferId;
    this.#hasherFactory = options.hasherFactory;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#clock = options.clock ?? systemClock;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#meter = new RateMeter(this.#clock);
    this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.#transport = options.transport;
    this.#chunkBytes = resolveChunkBytes(this.#limits, options.transport.maxMessageSize());
  }

  get state(): TransferState {
    return this.#stateMachine.state;
  }

  get contiguousBytes(): bigint {
    return this.#contiguousOffset;
  }

  get file(): FileMetadata | null {
    return this.#file;
  }

  markWaitingForPeer(): void {
    this.#transition("waiting-peer");
  }

  markAwaitingApproval(): void {
    this.#transition("awaiting-approval");
  }

  beginNegotiation(): void {
    this.#transition("negotiating");
  }

  /** The DataChannel is open; the receiver now waits for the sender's offer. */
  channelOpen(): void {
    if (this.#stopped) return;
    try {
      const state = this.#stateMachine.state;
      if (state === "preparing" || state === "waiting-peer" || state === "awaiting-approval") {
        this.#transition("negotiating");
      }
      if (this.#stateMachine.state === "negotiating") this.#transition("awaiting-accept");
    } catch (error) {
      this.#failFrom(error);
    }
  }

  setTransport(transport: ControlTransport): void {
    this.#transport = transport;
    this.#chunkBytes = resolveChunkBytes(this.#limits, transport.maxMessageSize());
  }

  handleControl(message: DataMessage): void {
    if (message.transferId !== this.transferId) {
      this.#fail("PROTOCOL_ERROR", "control message belongs to another transfer");
      return;
    }
    switch (message.type) {
      case "file-offer":
        this.#handleOffer(message.file);
        break;
      case "finish":
        void this.#completeTransfer(message);
        break;
      case "cancel":
        this.#fail("CANCELLED_BY_PEER", message.message ?? `sender cancelled: ${message.code}`);
        break;
      case "error":
        this.#fail(
          message.code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "PROTOCOL_ERROR",
          message.message ?? `sender error: ${message.code}`,
        );
        break;
      case "resume-ready":
        this.#handleResumeReady(BigInt(message.offset));
        break;
      case "accept":
      case "reject":
      case "ready":
      case "ack":
      case "verified":
      case "resume-request":
        break;
    }
  }

  /** Called from a user gesture after the save handle and writable stream exist. */
  accept(sink: ChunkSink): void {
    if (this.#stopped) return;
    if (!this.#file) {
      this.#fail("INVALID_STATE", "no file offer to accept");
      return;
    }
    if (this.#stateMachine.state !== "awaiting-accept") {
      this.#fail("INVALID_STATE", `cannot accept in state ${this.#stateMachine.state}`);
      return;
    }
    this.#sink = sink;
    this.#hasher = this.#hasherFactory();
    this.#expectedOffset = 0n;
    this.#contiguousOffset = 0n;
    this.#lastAckedOffset = 0n;
    this.#lastAckAt = this.#clock.now();
    this.#queuedBytes = 0;
    this.#writtenFrames = 0;
    this.#generation += 1;
    this.#writeChain = Promise.resolve();
    this.#lastProgressAt = 0;

    try {
      this.#transition("transferring");
    } catch (error) {
      this.#failFrom(error);
      return;
    }

    this.#sendControl({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "accept",
    });
    this.#sendControl({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "ready",
      offset: "0",
    });
    this.#emitProgress(true);
  }

  handleFrame(input: ArrayBuffer | ArrayBufferView): void {
    if (this.#stopped) return;
    const state = this.#stateMachine.state;
    if (state === "completed" || state === "cancelled" || state === "failed") return;
    if (state !== "transferring" || !this.#file || !this.#hasher) {
      this.#fail("PROTOCOL_ERROR", `data frame received in state ${state}`);
      return;
    }
    if (this.#queuedBytes > this.#limits.maxUnackedBytes * MAX_QUEUED_BYTES_FACTOR) {
      this.#fail("PROTOCOL_ERROR", "receiver write queue exceeded its bound");
      return;
    }

    let payload: Uint8Array;
    let offset: bigint;
    try {
      const frame = decodeDataFrame(input, {
        maxPayload: this.#chunkBytes,
        fileSize: this.#totalBytes,
      });
      payload = frame.payload;
      offset = frame.header.offset;
      if (payload.byteLength === 0) {
        throw new FrameError("INVALID_LENGTH", "zero-length data frame");
      }
    } catch (error) {
      const detail = error instanceof FrameError ? error.code : "decode failed";
      this.#fail("PROTOCOL_ERROR", `invalid data frame: ${detail}`);
      return;
    }

    if (offset < this.#expectedOffset) {
      // Duplicate after a resume/reconnect: already written and hashed.
      return;
    }
    if (offset > this.#expectedOffset) {
      this.#fail("PROTOCOL_ERROR", "data frame gap detected");
      return;
    }

    const length = payload.byteLength;
    const nextOffset = offset + BigInt(length);
    this.#expectedOffset = nextOffset;
    this.#queuedBytes += length;
    this.#enqueueWrite(offset, payload);
  }

  /**
   * Abort any pending writes, then ask the sender to resume at the confirmed
   * contiguous offset. Returns null when the receiver has already failed.
   */
  async prepareResume(): Promise<bigint | null> {
    if (this.#stopped) return null;
    if (this.#stateMachine.state === "transferring") {
      try {
        this.#transition("reconnecting");
      } catch (error) {
        this.#failFrom(error);
        return null;
      }
    }
    if (this.#stateMachine.state !== "reconnecting") return null;
    await this.#writeChain;
    if (this.#stopped) return null;
    this.#expectedOffset = this.#contiguousOffset;
    this.#sendControl({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "resume-request",
      offset: this.#contiguousOffset.toString(10),
    });
    this.#emit({ type: "resume-requested", offset: this.#contiguousOffset });
    return this.#contiguousOffset;
  }

  async cancel(code = "USER_CANCELLED", message = "receiver cancelled"): Promise<void> {
    if (this.#stopped) return;
    this.#sendControlBestEffort({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "cancel",
      code,
      message,
      partialBytes: this.#contiguousOffset.toString(10),
    });
    await this.#stopAndAbort(code, message, "cancelled");
  }

  dispose(): void {
    this.#generation += 1;
    this.#stopped = true;
  }

  #handleOffer(file: FileMetadata): void {
    if (this.#file) {
      if (
        this.#file.name === file.name &&
        this.#file.size === file.size &&
        this.#file.lastModified === file.lastModified
      ) {
        return;
      }
      this.#fail("PROTOCOL_ERROR", "received a different file offer on the same transfer");
      return;
    }
    const size = BigInt(file.size);
    if (size > this.#maxFileBytes) {
      this.#fail("SIZE_MISMATCH", "offered file exceeds the receiver limit");
      return;
    }
    const state = this.#stateMachine.state;
    if (
      state !== "preparing" &&
      state !== "waiting-peer" &&
      state !== "awaiting-approval" &&
      state !== "negotiating" &&
      state !== "awaiting-accept"
    ) {
      this.#fail("PROTOCOL_ERROR", `file offer is not valid in state ${state}`);
      return;
    }
    this.#file = file;
    this.#totalBytes = size;
    this.#transition("awaiting-accept");
    this.#emit({ type: "offer", file, sha256Known: false });
  }

  #handleResumeReady(offset: bigint): void {
    if (this.#stateMachine.state !== "reconnecting") {
      this.#fail("PROTOCOL_ERROR", "resume-ready arrived outside reconnection");
      return;
    }
    if (offset !== this.#contiguousOffset) {
      this.#fail("RESUME_REJECTED", "sender resumed from a different offset");
      return;
    }
    this.#expectedOffset = this.#contiguousOffset;
    try {
      this.#transition("transferring");
    } catch (error) {
      this.#failFrom(error);
    }
    this.#emitProgress(true);
  }

  #enqueueWrite(offset: bigint, payload: Uint8Array): void {
    const generation = this.#generation;
    const length = payload.byteLength;
    this.#writeChain = this.#writeChain
      .then(async () => {
        if (this.#stopped || generation !== this.#generation) return;
        const sink = this.#sink;
        if (!sink) throw new Error("sink is not ready");
        await sink.write(offset, payload);
        if (this.#stopped || generation !== this.#generation) return;
        this.#hasher?.update(payload);
        this.#contiguousOffset += BigInt(length);
        this.#queuedBytes -= length;
        this.#writtenFrames += 1;
        this.#afterWrite();
      })
      .catch((error: unknown) => {
        if (this.#stopped || generation !== this.#generation) return;
        this.#fail(
          "SINK_WRITE_FAILED",
          error instanceof Error ? error.message : "could not write to the destination",
        );
      });
  }

  #afterWrite(): void {
    const now = this.#clock.now();
    if (this.#queuedBytes === 0) {
      this.#sendAck();
    } else if (
      this.#contiguousOffset - this.#lastAckedOffset >= BigInt(this.#limits.ackIntervalBytes) ||
      now - this.#lastAckAt >= this.#limits.progressIntervalMs
    ) {
      this.#sendAck();
    }
    this.#emitProgress(false);
  }

  #sendAck(): void {
    this.#lastAckedOffset = this.#contiguousOffset;
    this.#lastAckAt = this.#clock.now();
    this.#sendControl({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "ack",
      offset: this.#contiguousOffset.toString(10),
    });
  }

  async #completeTransfer(message: FinishMessage): Promise<void> {
    if (this.#stopped) return;
    if (this.#stateMachine.state === "completed") {
      // The verified response may have been lost; repeat it idempotently.
      this.#sendVerified(message.sha256);
      return;
    }
    if (this.#finishing) return;
    if (this.#stateMachine.state !== "transferring" && this.#stateMachine.state !== "verifying") {
      if (this.#stateMachine.state === "reconnecting") {
        try {
          this.#transition("transferring");
        } catch (error) {
          this.#failFrom(error);
          return;
        }
      } else {
        this.#fail("PROTOCOL_ERROR", `finish received in state ${this.#stateMachine.state}`);
        return;
      }
    }
    this.#finishing = true;
    try {
      try {
        this.#transition("verifying");
      } catch (error) {
        if (!(error instanceof TransferStateError)) throw error;
      }
      this.#emit({ type: "verifying" });
      await this.#writeChain;
      if (this.#stopped) return;
      if (this.#queuedBytes !== 0) {
        this.#fail("SINK_WRITE_FAILED", "destination still has queued writes");
        return;
      }
      this.#sendAck();

      const declared = BigInt(message.totalBytes);
      if (declared !== this.#totalBytes || this.#contiguousOffset !== this.#totalBytes) {
        this.#fail(
          "SIZE_MISMATCH",
          `received ${this.#contiguousOffset} of ${this.#totalBytes} bytes`,
        );
        return;
      }
      if (!this.#hasher || !this.#sink) {
        this.#fail("INVALID_STATE", "receiver was not initialized");
        return;
      }

      let digest: string;
      try {
        digest = await this.#hasher.digestHex();
      } catch {
        this.#fail("SINK_WRITE_FAILED", "could not finalize the received hash");
        return;
      }
      if (this.#stopped) return;

      if (digest !== message.sha256) {
        this.#fail("HASH_MISMATCH", "received bytes do not match the sender hash");
        return;
      }

      try {
        await this.#sink.close();
      } catch {
        this.#fail("SINK_CLOSE_FAILED", "could not close the destination file");
        return;
      }
      if (this.#stopped) return;
      this.#closed = true;
      this.#sendVerified(digest);
      this.#transition("completed");
      this.#emit({ type: "completed", sha256: digest });
    } catch (error) {
      this.#failFrom(error);
    } finally {
      this.#finishing = false;
    }
  }

  #sendVerified(sha256: string): void {
    this.#sendControl({
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "verified",
      sha256,
    });
  }

  #emitProgress(force: boolean): void {
    const now = this.#clock.now();
    if (!force && now - this.#lastProgressAt < this.#limits.progressIntervalMs) return;
    this.#lastProgressAt = now;
    this.#meter.record(this.#contiguousOffset);
    const remaining = this.#totalBytes - this.#contiguousOffset;
    const { bytesPerSecond, etaMs } = this.#meter.sample(remaining);
    this.#emit({
      type: "progress",
      appliedBytes: this.#contiguousOffset,
      totalBytes: this.#totalBytes,
      bytesPerSecond,
      etaMs,
    });
  }

  #sendControl(message: DataMessage): void {
    if (this.#stopped) return;
    try {
      this.#transport.sendControl(message);
    } catch {
      this.#noteTransportLost("could not send a control message");
    }
  }

  #noteTransportLost(message: string): void {
    if (this.#stopped) return;
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
    this.#stateMachine.transition(next);
    this.#emit({ type: "state", state: next });
  }

  #emit(event: ReceiverEvent): void {
    try {
      this.#onEvent(event);
    } catch {
      /* UI callbacks must not break the transfer */
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
      protocolVersion: PROTOCOL_VERSION,
      transferId: this.transferId,
      type: "cancel",
      code,
      message: message.slice(0, 300),
      partialBytes: this.#contiguousOffset.toString(10),
    });
    void this.#stopAndAbort(code, message, "failed");
  }

  async #stopAndAbort(
    code: string,
    message: string,
    outcome: "failed" | "cancelled",
  ): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    const partial = this.#contiguousOffset;
    if (this.#stateMachine.state !== "completed") {
      try {
        this.#transition(outcome);
      } catch {
        /* already terminal */
      }
    }
    if (outcome === "cancelled") {
      this.#emit({ type: "cancelled", code });
    } else {
      this.#emit({
        type: "failed",
        code: code as TransferFailureCode,
        message,
        partialBytes: partial,
      });
    }
    const sink = this.#sink;
    this.#sink = null;
    if (sink && !this.#closed) {
      try {
        await sink.abort(message);
      } catch {
        /* browser may already have closed the stream */
      }
    }
  }
}
