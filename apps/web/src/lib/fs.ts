import type { ChunkSink, ChunkSource } from "@shareshare/transfer";
import { sanitizeFileName } from "./format.js";

export class UnsupportedBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBrowserError";
  }
}

export function fileSource(file: File): ChunkSource {
  return {
    size: BigInt(file.size),
    async read(position, length) {
      const start = Number(position);
      const end = start + length;
      const slice = file.slice(start, end);
      const buffer = await slice.arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

export class WritableSink implements ChunkSink {
  readonly #stream: FileSystemWritableFileStream;
  #settled = false;

  constructor(stream: FileSystemWritableFileStream) {
    this.#stream = stream;
  }

  async write(position: bigint, data: Uint8Array): Promise<void> {
    if (position > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("file position exceeds browser limits");
    }
    if (this.#settled) throw new Error("destination is closed");
    await this.#stream.write({
      type: "write",
      position: Number(position),
      data,
    } as FileSystemWriteChunkType);
  }

  async close(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await this.#stream.close();
  }

  async abort(_reason: string): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await this.#stream.abort();
  }
}

export async function pickSaveHandle(fileName: string): Promise<FileSystemFileHandle> {
  if (typeof window.showSaveFilePicker !== "function") {
    throw new UnsupportedBrowserError(
      "이 브라우저는 저장 위치 선택(File System Access API)을 지원하지 않습니다.",
    );
  }
  return window.showSaveFilePicker({
    suggestedName: sanitizeFileName(fileName),
  });
}

export async function openWritable(
  handle: FileSystemFileHandle,
  options: { keepExistingData?: boolean } = {},
): Promise<WritableSink> {
  const stream = await handle.createWritable({ keepExistingData: options.keepExistingData ?? false });
  return new WritableSink(stream);
}
