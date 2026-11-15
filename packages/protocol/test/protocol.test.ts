import { describe, expect, it } from "vitest";
import {
  FrameError,
  HEADER_BYTES,
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  decodeDataFrame,
  encodeDataFrame,
  parseDataMessage,
  parseFileSize,
  parseSignalingClientMessage,
  parseSignalingServerMessage,
  readDataHeader,
} from "@shareshare/protocol";

describe("data frames", () => {
  it("round-trips a payload with an exact 64-bit offset", () => {
    const offset = 10n * 1024n * 1024n * 1024n + 12345n; // > 2^32, within 10 GiB
    const payload = new Uint8Array(16 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

    const encoded = encodeDataFrame({ sequence: 42, offset, payload });
    expect(encoded.byteLength).toBe(HEADER_BYTES + payload.byteLength);
    expect(readDataHeader(encoded)).toMatchObject({
      version: PROTOCOL_VERSION,
      sequence: 42,
      offset,
      payloadLength: payload.byteLength,
    });

    const decoded = decodeDataFrame(encoded, { fileSize: offset + BigInt(payload.byteLength) });
    expect(decoded.header.offset).toBe(offset);
    expect(decoded.payload).toEqual(payload);
  });

  it("does not truncate offsets above the 32-bit range", () => {
    const offset = 10n * 1024n * 1024n * 1024n + 1n; // > 10 GiB, > 2^32
    const encoded = encodeDataFrame({ sequence: 1, offset, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeDataFrame(encoded).header.offset).toBe(offset);
  });

  it("rejects an unsupported version", () => {
    const encoded = encodeDataFrame({ sequence: 0, offset: 0n, payload: new Uint8Array([1]) });
    encoded[0] = 2;
    expect(() => decodeDataFrame(encoded)).toThrowError(FrameError);
    try {
      decodeDataFrame(encoded);
    } catch (error) {
      expect((error as FrameError).code).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("rejects unknown frame types, reserved flags, and truncated payloads", () => {
    const valid = encodeDataFrame({ sequence: 0, offset: 0n, payload: new Uint8Array([1, 2]) });
    const wrongType = valid.slice();
    wrongType[1] = 9;
    expect(() => decodeDataFrame(wrongType)).toThrow(/unknown frame type/);

    const wrongFlags = valid.slice();
    wrongFlags[3] = 1;
    expect(() => decodeDataFrame(wrongFlags)).toThrow(/reserved/);

    const truncated = valid.slice(0, valid.byteLength - 1);
    expect(() => decodeDataFrame(truncated)).toThrow(/length/);
  });

  it("rejects frames that overrun the declared file size", () => {
    const encoded = encodeDataFrame({
      sequence: 0,
      offset: 10n,
      payload: new Uint8Array(10),
    });
    expect(() => decodeDataFrame(encoded, { fileSize: 15n })).toThrow(/declared file size/);
  });

  it("rejects oversized and malformed payloads", () => {
    expect(() =>
      encodeDataFrame({ sequence: 0, offset: 0n, payload: new Uint8Array(70 * 1024) }),
    ).toThrow(/protocol frame cap/);
    expect(() => decodeDataFrame(new Uint8Array(HEADER_BYTES - 1))).toThrow(/header/);

    const encoded = encodeDataFrame({ sequence: 0, offset: 0n, payload: new Uint8Array(2048) });
    expect(() => decodeDataFrame(encoded, { maxPayload: 1024 })).toThrow(/negotiated/);
  });

  it("rejects frames past the supported file cap", () => {
    expect(() =>
      encodeDataFrame({ sequence: 0, offset: MAX_FILE_BYTES, payload: new Uint8Array(1) }),
    ).toThrow(/supported file cap/);
  });
});

describe("size parsing", () => {
  it("accepts canonical decimal sizes and rejects ambiguous forms", () => {
    expect(parseFileSize("0")).toBe(0n);
    expect(parseFileSize("10737418240")).toBe(10n * 1024n * 1024n * 1024n);
    expect(() => parseFileSize("01")).toThrow();
    expect(() => parseFileSize("-1")).toThrow();
    expect(() => parseFileSize("1.5")).toThrow();
    expect(() => parseFileSize((MAX_FILE_BYTES + 1n).toString())).toThrow();
  });
});

describe("control messages", () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    transferId: "abcdefgh1234",
  } as const;

  it("parses file offers with decimal sizes", () => {
    const message = parseDataMessage({
      ...base,
      type: "file-offer",
      file: {
        name: "보고서 🚀.pdf",
        size: "10737418240",
        lastModified: 1_700_000_000_000,
        mime: "application/pdf",
      },
    });
    expect(message.type).toBe("file-offer");
    if (message.type === "file-offer") expect(message.file.size).toBe("10737418240");
  });

  it("rejects numeric sizes, control characters, and unknown types", () => {
    expect(() =>
      parseDataMessage({
        ...base,
        type: "file-offer",
        file: { name: "a.bin", size: 10, lastModified: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseDataMessage({
        ...base,
        type: "file-offer",
        file: { name: "bad\u0000name", size: "10", lastModified: 0 },
      }),
    ).toThrow();
    expect(() => parseDataMessage({ ...base, type: "teleport" })).toThrow();
    expect(() => parseDataMessage({ ...base, type: "ack", offset: "-1" })).toThrow();
  });

  it("parses finish and requires a lowercase SHA-256", () => {
    const finish = {
      ...base,
      type: "finish",
      totalBytes: "1024",
      totalChunks: 1,
      sha256: "a".repeat(64),
    };
    expect(parseDataMessage(finish).type).toBe("finish");
    expect(() => parseDataMessage({ ...finish, sha256: "A".repeat(64) })).toThrow();
    expect(() => parseDataMessage({ ...finish, totalChunks: -1 })).toThrow();
  });

  it("parses signaling messages and rejects invalid tokens", () => {
    const create = parseSignalingClientMessage({
      ...base,
      type: "create-room",
      file: { name: "a", size: "0", lastModified: 0 },
    });
    expect(create.type).toBe("create-room");

    expect(() =>
      parseSignalingClientMessage({
        ...base,
        type: "join-room",
        roomId: "short",
        inviteToken: "x".repeat(32),
      }),
    ).toThrow();

    expect(() =>
      parseSignalingClientMessage({
        ...base,
        type: "join-room",
        roomId: "a".repeat(20),
        inviteToken: "not a token!",
      }),
    ).toThrow();
  });

  it("parses server errors without leaking payload details", () => {
    const parsed = parseSignalingServerMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      code: "ROOM_NOT_FOUND",
    });
    expect(parsed.type).toBe("error");
  });

  it("requires the protocol version on every message", () => {
    expect(() =>
      parseDataMessage({ transferId: "abcdefgh1234", type: "accept" }),
    ).toThrow();
  });
});
