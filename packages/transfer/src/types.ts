import type { DataMessage, FileMetadata } from "@shareshare/protocol";

export type TransferState =
  | "idle"
  | "preparing"
  | "waiting-peer"
  | "awaiting-approval"
  | "negotiating"
  | "awaiting-accept"
  | "transferring"
  | "reconnecting"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
};

export interface ChunkSource {
  /** Total number of bytes available. Must remain stable for the transfer. */
  readonly size: bigint;
  /** Returns exactly `length` bytes at `position`, or fewer when the source changed. */
  read(position: bigint, length: number): Promise<Uint8Array>;
}

export interface ChunkSink {
  /** Write bytes at an absolute position. Writes are serialized by the receiver. */
  write(position: bigint, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface Hasher {
  /** Synchronous enqueue. Ordering with digestHex() is preserved by implementations. */
  update(data: Uint8Array): void;
  digestHex(): Promise<string>;
}

export type HasherFactory = () => Hasher;

export interface ControlTransport {
  sendControl(message: DataMessage): void;
  sendFrame(frame: Uint8Array): void;
  /** Bytes currently queued by the transport (RTCDataChannel.bufferedAmount). */
  bufferedAmount(): number;
  /** Maximum size of a single DataChannel message, header included. */
  maxMessageSize(): number;
  /** Subscribe to the transport's low-water mark. Returns an unsubscribe function. */
  onDrain(listener: () => void): () => void;
}

export interface TransferLimits {
  /** Desired payload size. Clamped to the negotiated DataChannel limit. */
  chunkBytes: number;
  /** Pause sending while the transport queue is above this value. */
  highWaterBytes: number;
  /** Advisory low-water mark; transports should fire onDrain below this. */
  lowWaterBytes: number;
  /** Maximum bytes sent but not yet acknowledged by the receiver's disk. */
  maxUnackedBytes: number;
  /** Receiver sends an ACK after this many contiguous written bytes. */
  ackIntervalBytes: number;
  progressIntervalMs: number;
  /** Fail when no ACK/space becomes available for this long mid-transfer. */
  stallTimeoutMs: number;
  /** Resend finish while waiting for the receiver's verified response. */
  verifyTimeoutMs: number;
  verifyRetries: number;
  maxControlMessageBytes: number;
}

export const DEFAULT_LIMITS: TransferLimits = {
  chunkBytes: 16 * 1024,
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  maxUnackedBytes: 8 * 1024 * 1024,
  ackIntervalBytes: 1024 * 1024,
  progressIntervalMs: 200,
  stallTimeoutMs: 30_000,
  verifyTimeoutMs: 10_000,
  verifyRetries: 3,
  maxControlMessageBytes: 64 * 1024,
};

export type TransferFailureCode =
  | "PROTOCOL_ERROR"
  | "HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "SOURCE_READ_FAILED"
  | "SOURCE_CHANGED"
  | "SINK_WRITE_FAILED"
  | "SINK_CLOSE_FAILED"
  | "ACK_TIMEOUT"
  | "VERIFY_TIMEOUT"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_LIMIT"
  | "REJECTED"
  | "CANCELLED_BY_PEER"
  | "RESUME_REJECTED"
  | "INVALID_STATE";

export type SenderEvent =
  | { type: "state"; state: TransferState }
  | {
      type: "progress";
      sentBytes: bigint;
      ackedBytes: bigint;
      totalBytes: bigint;
      bytesPerSecond: number;
      etaMs: number | null;
    }
  | { type: "offer-sent"; file: FileMetadata }
  | { type: "verified"; sha256: string }
  | { type: "resuming"; offset: bigint }
  | { type: "transport-lost"; message: string }
  | { type: "cancelled"; code: string }
  | {
      type: "failed";
      code: TransferFailureCode;
      message: string;
      partialBytes?: bigint;
    }
  | { type: "completed"; sha256: string };

export type ReceiverEvent =
  | { type: "state"; state: TransferState }
  | { type: "offer"; file: FileMetadata; sha256Known: false }
  | {
      type: "progress";
      appliedBytes: bigint;
      totalBytes: bigint;
      bytesPerSecond: number;
      etaMs: number | null;
    }
  | { type: "verifying" }
  | { type: "resume-requested"; offset: bigint }
  | { type: "transport-lost"; message: string }
  | { type: "cancelled"; code: string }
  | {
      type: "failed";
      code: TransferFailureCode;
      message: string;
      partialBytes?: bigint;
    }
  | { type: "completed"; sha256: string };

export interface SenderOptions {
  transferId: string;
  source: ChunkSource;
  file: FileMetadata;
  transport: ControlTransport;
  hasherFactory: HasherFactory;
  onEvent?: (event: SenderEvent) => void;
  clock?: Clock;
  limits?: Partial<TransferLimits>;
}

export interface ReceiverOptions {
  transferId: string;
  transport: ControlTransport;
  hasherFactory: HasherFactory;
  onEvent?: (event: ReceiverEvent) => void;
  clock?: Clock;
  limits?: Partial<TransferLimits>;
  /** Upper bound used while waiting for the file offer. */
  maxFileBytes?: bigint;
}
