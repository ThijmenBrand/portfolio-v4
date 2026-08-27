import { ebadf, erofs } from "../errors";
import type { Signal } from "../proc/signals";

export interface PipeBufferInterface {
  read(length: number, signal: Signal): Array<Uint8Array>;
  write(data: Uint8Array): void;
  closeRead(): void;
  closeWrite(): void;
}

export class PipeBuffer implements PipeBufferInterface {
  private static readonly CAPACITY = 64 * 1024;

  private readonly chunks: Array<Uint8Array> = [];
  private headOffset: number = 0;
  private buffered: number = 0;
  private readerCount: number = 0;
  private writerCount: number = 0;

  public write(data: Uint8Array) {
    let written = 0;

    while (written < data.length) {
      while (this.buffered >= PipeBuffer.CAPACITY) {
        if (this.readerCount === 0) throw epipe();
      }
    }
    this.chunks.push(data);
    this.buffered++;
  }

  public read(length: number, signal: Signal): Array<Uint8Array> {
    const bytesLeft = this.buffered - this.headOffset;
    if (length > bytesLeft) throw erofs;

    const chunks = this.chunks.slice(this.headOffset, length);
    this.headOffset += length;

    return chunks;
  }

  public closeRead(): void {}
}
