import {
  FRAME,
  HEADER_BYTES,
  MAX_FILE_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  U64_MAX,
} from "./constants.js";

export type FrameErrorCode =
  | "FRAME_TOO_SHORT"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_FRAME_TYPE"
  | "INVALID_FLAGS"
  | "INVALID_LENGTH"
  | "PAYLOAD_TOO_LARGE"
  | "OFFSET_OUT_OF_RANGE"
  | "SEQUENCE_OUT_OF_RANGE";

export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export interface DataHeader {
  version: number;
  frameType: number;
  flags: number;
  sequence: number;
  offset: bigint;
  payloadLength: number;
}

export interface DecodedDataFrame {
  header: DataHeader;
  payload: Uint8Array;
}

export interface DecodeOptions {
  /** Maximum payload accepted by this connection; defaults to the protocol cap. */
  maxPayload?: number;
  /** Total file size, used to reject frames that overrun the declared file. */
  fileSize?: bigint;
}

function toUint8(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export function encodeDataFrame(input: {
  sequence: number;
  offset: bigint;
  payload: Uint8Array;
}): Uint8Array {
  const { sequence, offset, payload } = input;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new FrameError("SEQUENCE_OUT_OF_RANGE", "sequence must fit in uint32");
  }
  if (offset < 0n || offset > U64_MAX) {
    throw new FrameError("OFFSET_OUT_OF_RANGE", "offset must fit in uint64");
  }
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new FrameError("PAYLOAD_TOO_LARGE", "payload exceeds the protocol frame cap");
  }
  const length = payload.byteLength;
  if (offset + BigInt(length) > MAX_FILE_BYTES) {
    throw new FrameError("OFFSET_OUT_OF_RANGE", "frame ends beyond the supported file cap");
  }

  const buffer = new Uint8Array(HEADER_BYTES + length);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, FRAME.DATA);
  view.setUint16(2, 0, false);
  view.setUint32(4, sequence, false);
  view.setBigUint64(8, offset, false);
  view.setUint32(16, length, false);
  buffer.set(payload, HEADER_BYTES);
  return buffer;
}

export function decodeDataFrame(
  input: ArrayBuffer | ArrayBufferView,
  options: DecodeOptions = {},
): DecodedDataFrame {
  const bytes = toUint8(input);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new FrameError("FRAME_TOO_SHORT", "frame is shorter than its header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new FrameError("UNSUPPORTED_VERSION", "unsupported protocol version");
  }
  const frameType = view.getUint8(1);
  if (frameType !== FRAME.DATA) {
    throw new FrameError("UNKNOWN_FRAME_TYPE", "unknown frame type");
  }
  const flags = view.getUint16(2, false);
  if (flags !== 0) {
    throw new FrameError("INVALID_FLAGS", "reserved frame flags must be zero");
  }
  const sequence = view.getUint32(4, false);
  const offset = view.getBigUint64(8, false);
  const payloadLength = view.getUint32(16, false);

  const maxPayload = Math.min(options.maxPayload ?? MAX_FRAME_PAYLOAD_BYTES, MAX_FRAME_PAYLOAD_BYTES);
  if (payloadLength > maxPayload) {
    throw new FrameError("PAYLOAD_TOO_LARGE", "payload exceeds the negotiated message limit");
  }
  if (payloadLength !== bytes.byteLength - HEADER_BYTES) {
    throw new FrameError("INVALID_LENGTH", "payload length does not match the frame size");
  }
  if (offset > U64_MAX - BigInt(payloadLength)) {
    throw new FrameError("OFFSET_OUT_OF_RANGE", "offset and length overflow uint64");
  }
  if (options.fileSize !== undefined) {
    if (options.fileSize < 0n || options.fileSize > MAX_FILE_BYTES) {
      throw new FrameError("OFFSET_OUT_OF_RANGE", "declared file size is outside protocol limits");
    }
    if (offset + BigInt(payloadLength) > options.fileSize) {
      throw new FrameError("OFFSET_OUT_OF_RANGE", "frame overruns the declared file size");
    }
  } else if (offset + BigInt(payloadLength) > MAX_FILE_BYTES) {
    throw new FrameError("OFFSET_OUT_OF_RANGE", "frame ends beyond the supported file cap");
  }

  return {
    header: { version, frameType, flags, sequence, offset, payloadLength },
    payload: bytes.subarray(HEADER_BYTES),
  };
}

/** Read-only header inspection without trusting or copying a payload. */
export function readDataHeader(input: ArrayBuffer | ArrayBufferView): DataHeader {
  const bytes = toUint8(input);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new FrameError("FRAME_TOO_SHORT", "frame is shorter than its header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint8(0),
    frameType: view.getUint8(1),
    flags: view.getUint16(2, false),
    sequence: view.getUint32(4, false),
    offset: view.getBigUint64(8, false),
    payloadLength: view.getUint32(16, false),
  };
}
