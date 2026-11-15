/// <reference lib="webworker" />

import { sha256 } from "@noble/hashes/sha2.js";

type IncomingMessage =
  | { type: "update"; data: ArrayBuffer }
  | { type: "digest"; id: number };

let hasher = sha256.create();

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  try {
    if (message.type === "update") {
      hasher.update(new Uint8Array(message.data));
      return;
    }
    if (message.type === "digest") {
      const hex = toHex(hasher.digest());
      self.postMessage({ type: "digest", id: message.id, hex });
      // One transfer uses one digest; let the worker be collected.
      self.close();
    }
  } catch (error) {
    self.postMessage({
      type: "digest",
      id: message.type === "digest" ? message.id : -1,
      error: error instanceof Error ? error.message : "hash failed",
    });
  }
};

export {};
