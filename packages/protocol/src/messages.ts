import { z } from "zod";
import {
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_MIME_LENGTH,
  PROTOCOL_VERSION,
  SHA256_HEX_LENGTH,
  SIGNALING_ERROR_CODES,
} from "./constants.js";

const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const transferIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "transferId must be an identifier");

export const roomIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "roomId must be an identifier");

export const tokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "token must be url-safe base64");

const connectionCodeSchema = z.string().regex(/^[0-9]{6,8}$/, "connection code must be numeric");

export const sha256HexSchema = z
  .string()
  .length(SHA256_HEX_LENGTH)
  .regex(/^[0-9a-f]+$/, "sha256 must be lowercase hex");

const decimalSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/, "value must be an unsigned decimal integer");

export const fileSizeSchema = decimalSchema.refine(
  (value) => BigInt(value) <= MAX_FILE_BYTES,
  "file size exceeds the supported maximum",
);

export const byteOffsetSchema = decimalSchema.refine(
  (value) => BigInt(value) <= MAX_FILE_BYTES,
  "offset exceeds the supported maximum",
);

const fileNameSchema = z
  .string()
  .min(1)
  .max(MAX_FILE_NAME_LENGTH)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "file name must not contain control characters",
  );

const mimeSchema = z.string().min(1).max(MAX_MIME_LENGTH);

const reasonSchema = z.string().min(1).max(300);

export const fileMetadataSchema = z.object({
  name: fileNameSchema,
  size: fileSizeSchema,
  lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: mimeSchema.optional(),
});

const baseShape = {
  protocolVersion: protocolVersionSchema,
  transferId: transferIdSchema,
};

export const dataMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseShape,
    type: z.literal("file-offer"),
    file: fileMetadataSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("accept"),
  }),
  z.object({
    ...baseShape,
    type: z.literal("reject"),
    reason: reasonSchema.optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("ready"),
    offset: byteOffsetSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("ack"),
    offset: byteOffsetSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("finish"),
    totalBytes: fileSizeSchema,
    totalChunks: z.number().int().nonnegative().max(0xffff_ffff),
    sha256: sha256HexSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("verified"),
    sha256: sha256HexSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("cancel"),
    code: z.string().min(1).max(64),
    message: z.string().max(300).optional(),
    partialBytes: byteOffsetSchema.optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("resume-request"),
    offset: byteOffsetSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("resume-ready"),
    offset: byteOffsetSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("error"),
    code: z.string().min(1).max(64),
    message: z.string().max(300).optional(),
    fatal: z.boolean().optional(),
  }),
]);

export type DataMessage = z.infer<typeof dataMessageSchema>;
export type FileMetadata = z.infer<typeof fileMetadataSchema>;
export type AckMessage = Extract<DataMessage, { type: "ack" }>;
export type FinishMessage = Extract<DataMessage, { type: "finish" }>;
export type FileOfferMessage = Extract<DataMessage, { type: "file-offer" }>;

export const iceCandidateDataSchema = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().max(65535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export type IceCandidateData = z.infer<typeof iceCandidateDataSchema>;

export const iceServerSchema = z.object({
  urls: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(8)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
});

export type IceServerConfig = z.infer<typeof iceServerSchema>;

const sdpSchema = z.string().min(1).max(60_000);

export const signalingClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseShape,
    type: z.literal("create-room"),
    file: fileMetadataSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("join-room"),
    roomId: roomIdSchema,
    inviteToken: tokenSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("resume-session"),
    roomId: roomIdSchema,
    sessionToken: tokenSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("approve-peer"),
    connectionCode: connectionCodeSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("offer"),
    sdp: sdpSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("answer"),
    sdp: sdpSchema,
  }),
  z.object({
    ...baseShape,
    type: z.literal("ice-candidate"),
    candidate: iceCandidateDataSchema.nullable(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("heartbeat"),
    nonce: z.string().max(64).optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal("leave-room"),
  }),
]);

export type SignalingClientMessage = z.infer<typeof signalingClientMessageSchema>;

const serverBaseShape = {
  protocolVersion: protocolVersionSchema,
  transferId: transferIdSchema,
};

export const signalingServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...serverBaseShape,
    type: z.literal("room-created"),
    roomId: roomIdSchema,
    senderToken: tokenSchema,
    inviteToken: tokenSchema,
    connectionCode: connectionCodeSchema,
    expiresAt: z.number().int().nonnegative(),
    iceServers: z.array(iceServerSchema).max(8),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("joined"),
    roomId: roomIdSchema,
    sessionToken: tokenSchema,
    connectionCode: connectionCodeSchema,
    expiresAt: z.number().int().nonnegative(),
    senderPresent: z.boolean(),
    iceServers: z.array(iceServerSchema).max(8),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("resumed"),
    roomId: roomIdSchema,
    role: z.enum(["sender", "receiver"]),
    connectionCode: connectionCodeSchema,
    expiresAt: z.number().int().nonnegative(),
    approved: z.boolean(),
    peerPresent: z.boolean(),
    iceServers: z.array(iceServerSchema).max(8),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("peer-joined"),
    role: z.enum(["sender", "receiver"]),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("peer-left"),
    role: z.enum(["sender", "receiver"]),
    final: z.boolean(),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("peer-approved"),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("peer-reconnected"),
    role: z.enum(["sender", "receiver"]),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("offer"),
    sdp: sdpSchema,
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("answer"),
    sdp: sdpSchema,
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("ice-candidate"),
    candidate: iceCandidateDataSchema.nullable(),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("heartbeat-ack"),
    receivedAt: z.number().int().nonnegative(),
  }),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("error"),
    transferId: transferIdSchema.optional(),
    code: z.enum(SIGNALING_ERROR_CODES),
    message: z.string().max(300).optional(),
  }),
  z.object({
    ...serverBaseShape,
    type: z.literal("room-expired"),
  }),
]);

export type SignalingServerMessage = z.infer<typeof signalingServerMessageSchema>;

export class MessageValidationError extends Error {
  readonly issues: string[];

  constructor(kind: string, issues: string[]) {
    super(`invalid ${kind} message`);
    this.name = "MessageValidationError";
    this.issues = issues;
  }
}

export function formatZodIssues(error: z.ZodError): string[] {
  // Never include received values: messages can contain file names or tokens.
  return error.issues.slice(0, 8).map((issue) => issue.path.join(".") || "(root)");
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, kind: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MessageValidationError(kind, formatZodIssues(result.error));
  return result.data;
}

export function parseDataMessage(value: unknown): DataMessage {
  return parseWith(dataMessageSchema, value, "data");
}

export function parseSignalingClientMessage(value: unknown): SignalingClientMessage {
  return parseWith(signalingClientMessageSchema, value, "signaling client");
}

export function parseSignalingServerMessage(value: unknown): SignalingServerMessage {
  return parseWith(signalingServerMessageSchema, value, "signaling server");
}

/**
 * Parse a JSON text message. Returns null for syntactically invalid JSON so
 * callers can answer with a generic error code without echoing the payload.
 */
export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
