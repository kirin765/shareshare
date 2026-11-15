import { MAX_FILE_BYTES, U64_MAX } from "./constants.js";

export class SizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizeError";
  }
}

export function parseU64(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SizeError("size must be a non-negative decimal integer");
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    throw new SizeError("size exceeds the unsigned 64-bit range");
  }
  return parsed;
}

export function parseFileSize(value: string): bigint {
  const parsed = parseU64(value);
  if (parsed > MAX_FILE_BYTES) {
    throw new SizeError("file size exceeds the supported maximum");
  }
  return parsed;
}

export function formatU64(value: bigint): string {
  if (value < 0n || value > U64_MAX) {
    throw new SizeError("size must be an unsigned 64-bit integer");
  }
  return value.toString(10);
}

/** True when the value can be passed to browser APIs that use Number positions. */
export function isSafePosition(value: bigint): boolean {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}
