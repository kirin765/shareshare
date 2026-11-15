import type { Hasher } from "@shareshare/transfer";

interface DigestResponse {
  type: "digest";
  id: number;
  hex?: string;
  error?: string;
}

export class WorkerHasher implements Hasher {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (hex: string) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #dead = false;
  onDispose: (() => void) | null = null;

  constructor() {
    this.#worker = new Worker(new URL("../workers/hash.worker.ts", import.meta.url), {
      type: "module",
      name: "shareshare-sha256",
    });
    this.#worker.onmessage = (event: MessageEvent<DigestResponse>) => {
      const message = event.data;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.hex) pending.resolve(message.hex);
      else pending.reject(new Error(message.error ?? "hash worker failed"));
      // One transfer hashes one file; free the worker as soon as the digest is known.
      this.dispose();
    };
    this.#worker.onerror = () => {
      this.#rejectAll(new Error("hash worker crashed"));
    };
    this.#worker.onmessageerror = () => {
      this.#rejectAll(new Error("hash worker message error"));
    };
  }

  update(data: Uint8Array): void {
    if (this.#dead) throw new Error("hasher is closed");
    // Copy: the transfer core still needs the original buffer for sending/writing.
    const copy = data.slice();
    this.#worker.postMessage({ type: "update", data: copy.buffer }, [copy.buffer]);
  }

  digestHex(): Promise<string> {
    if (this.#dead) return Promise.reject(new Error("hasher is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type: "digest", id });
    });
  }

  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#rejectAll(new Error("hasher disposed"));
    this.#worker.terminate();
    const callback = this.onDispose;
    this.onDispose = null;
    callback?.();
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export class WorkerHasherFactory {
  readonly #active = new Set<WorkerHasher>();

  create(): WorkerHasher {
    const hasher = new WorkerHasher();
    this.#active.add(hasher);
    hasher.onDispose = () => {
      this.#active.delete(hasher);
    };
    return hasher;
  }

  disposeAll(): void {
    for (const hasher of [...this.#active]) hasher.dispose();
    this.#active.clear();
  }
}

export function createWorkerHasherFactory(): WorkerHasherFactory {
  return new WorkerHasherFactory();
}
