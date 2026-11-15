import type { DataMessage } from "@shareshare/protocol";
import type { ControlTransport } from "@shareshare/transfer";

export const LOW_WATER_BYTES = 256 * 1024;
export const HIGH_WATER_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/** Adapts an RTCDataChannel to the transfer core's narrow transport interface. */
export class ChannelTransport implements ControlTransport {
  readonly #channel: RTCDataChannel;

  constructor(channel: RTCDataChannel) {
    this.#channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
  }

  sendControl(message: DataMessage): void {
    // Control messages are text frames; binary frames are reserved for file
    // bytes and are parsed with the fixed 20-byte header.
    const text = JSON.stringify(message);
    if (encoder.encode(text).byteLength > 32 * 1024) {
      throw new Error("control message is too large");
    }
    this.#channel.send(text);
  }

  sendFrame(frame: Uint8Array): void {
    this.#channel.send(frame as unknown as ArrayBufferView<ArrayBuffer>);
  }

  bufferedAmount(): number {
    return this.#channel.bufferedAmount;
  }

  maxMessageSize(): number {
    const transport = (this.#channel as unknown as { sctp?: { maxMessageSize?: number } }).sctp;
    const max = transport?.maxMessageSize;
    return typeof max === "number" && max > 0 ? max : 65536;
  }

  onDrain(listener: () => void): () => void {
    this.#channel.addEventListener("bufferedamountlow", listener);
    return () => this.#channel.removeEventListener("bufferedamountlow", listener);
  }

  get channel(): RTCDataChannel {
    return this.#channel;
  }
}
