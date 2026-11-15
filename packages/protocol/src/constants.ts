/**
 * Wire-level constants for ShareShare protocol v1.
 *
 * Offsets and sizes are represented as unsigned 64-bit integers on the wire
 * (BigInt in TypeScript, decimal strings in JSON control messages) so that file
 * sizes beyond 2^53 can be expressed without losing precision. The application
 * cap is intentionally lower than Number.MAX_SAFE_INTEGER because browsers use
 * Number positions for File System Access writes.
 */
export const PROTOCOL_VERSION = 1 as const;

export const FRAME = {
  DATA: 1,
} as const;

/** version(1) + type(1) + flags(2) + seq(4) + offset(8) + payloadLength(4) */
export const HEADER_BYTES = 20;

/** Application-level cap. 10 GiB is the verification target; 64 GiB is the hard limit. */
export const MAX_FILE_BYTES = 64n * 1024n * 1024n * 1024n;

/** Exact upper bound representable in the 64-bit offset field. */
export const U64_MAX = (1n << 64n) - 1n;

/** Hard safety cap for a single frame payload. Negotiated limits can only lower it. */
export const MAX_FRAME_PAYLOAD_BYTES = 64 * 1024;

/** Lowest DataChannel message limit we are willing to operate with (header included). */
export const MIN_DATACHANNEL_MESSAGE_BYTES = 2 * 1024;

export const DEFAULT_CHUNK_BYTES = 16 * 1024;

export const DEFAULT_MESSAGE_BYTES = 64 * 1024;

export const TRANSFER_ID_MIN_LENGTH = 8;
export const TRANSFER_ID_MAX_LENGTH = 64;

export const MAX_FILE_NAME_LENGTH = 1024;
export const MAX_MIME_LENGTH = 255;

export const SHA256_HEX_LENGTH = 64;

export const DATA_MESSAGE_TYPES = [
  "file-offer",
  "accept",
  "reject",
  "ready",
  "ack",
  "finish",
  "verified",
  "cancel",
  "resume-request",
  "resume-ready",
  "error",
] as const;

export type DataMessageType = (typeof DATA_MESSAGE_TYPES)[number];

export const SIGNALING_CLIENT_MESSAGE_TYPES = [
  "create-room",
  "join-room",
  "resume-session",
  "approve-peer",
  "offer",
  "answer",
  "ice-candidate",
  "heartbeat",
  "leave-room",
] as const;

export type SignalingClientMessageType = (typeof SIGNALING_CLIENT_MESSAGE_TYPES)[number];

export const SIGNALING_SERVER_MESSAGE_TYPES = [
  "room-created",
  "joined",
  "resumed",
  "peer-joined",
  "peer-left",
  "peer-approved",
  "peer-reconnected",
  "offer",
  "answer",
  "ice-candidate",
  "heartbeat-ack",
  "error",
  "room-expired",
] as const;

export type SignalingServerMessageType = (typeof SIGNALING_SERVER_MESSAGE_TYPES)[number];

export const SIGNALING_ERROR_CODES = [
  "INVALID_MESSAGE",
  "UNSUPPORTED_VERSION",
  "ORIGIN_NOT_ALLOWED",
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
  "INVALID_CREDENTIAL",
  "ROOM_FULL",
  "ALREADY_APPROVED",
  "NOT_APPROVED",
  "NOT_ROOM_OWNER",
  "BAD_CONNECTION_CODE",
  "RATE_LIMITED",
  "MESSAGE_TOO_LARGE",
  "SERVER_BUSY",
  "SESSION_DISCONNECTED",
  "INTERNAL_ERROR",
] as const;

export type SignalingErrorCode = (typeof SIGNALING_ERROR_CODES)[number];
