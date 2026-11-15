import { sha256 } from "@noble/hashes/sha2.js";
import type { Hasher } from "./types.js";

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

/** Incremental SHA-256 backed by @noble/hashes (audited, MIT, zero dependencies). */
export class Sha256Hasher implements Hasher {
  #hasher = sha256.create();
  #digested: string | null = null;

  update(data: Uint8Array): void {
    if (this.#digested !== null) throw new Error("hasher is already finalized");
    this.#hasher.update(data);
  }

  digestHex(): Promise<string> {
    if (this.#digested === null) {
      this.#digested = toHex(this.#hasher.digest());
    }
    return Promise.resolve(this.#digested);
  }
}

export function createSha256Hasher(): Hasher {
  return new Sha256Hasher();
}

export async function hashBytes(data: Uint8Array): Promise<string> {
  const hasher = new Sha256Hasher();
  hasher.update(data);
  return hasher.digestHex();
}
