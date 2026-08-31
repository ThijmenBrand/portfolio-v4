import { ebadf, eintr, epipe } from "../errors";
import type { Stat } from "../fs/types";
import type { Bytes } from "../types";
import type { OpenFile } from "./openfile";

type Waker = () => void;

export class PipeBuffer {
  private static readonly CAPACITY = 64 * 1024;
  private static nextId = 1;

  public readonly description = `pipe:[${PipeBuffer.nextId++}]`;

  private readonly chunks: Bytes[] = [];
  private headOffset = 0; // bytes consumed from chunks[0]
  private buffered = 0; // readable bytes across ALL chunks
  private readonly createdAt = Date.now();

  private readerCount = 1;
  private writerCount = 1;

  private readonly readWaiters: Waker[] = [];
  private readonly writeWaiters: Waker[] = [];

  public async read(length: number, signal?: AbortSignal): Promise<Bytes> {
    while (this.buffered === 0) {
      if (this.writerCount === 0) return new Uint8Array(0); // EOF
      await this.park(this.readWaiters, signal);
    }

    const take = Math.min(length, this.buffered);
    const out = new Uint8Array(take);
    let filled = 0;

    while (filled < take) {
      const head = this.chunks[0];
      const n = Math.min(head.length - this.headOffset, take - filled);
      out.set(head.subarray(this.headOffset, this.headOffset + n), filled);
      filled += n;
      this.headOffset += n;
      if (this.headOffset === head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    this.buffered -= take;
    this.wake(this.writeWaiters);
    return out;
  }

  public async write(data: Bytes, signal?: AbortSignal): Promise<number> {
    let written = 0;

    while (written < data.length) {
      while (this.buffered >= PipeBuffer.CAPACITY) {
        if (this.readerCount === 0) throw epipe(this.description);
        await this.park(this.writeWaiters, signal);
      }
      if (this.readerCount === 0) throw epipe(this.description);

      const room = PipeBuffer.CAPACITY - this.buffered;
      const slice = data.slice(written, written + room); // COPY on ingress
      this.chunks.push(slice);
      this.buffered += slice.length;
      written += slice.length;
      this.wake(this.readWaiters);
    }

    return written;
  }

  public stat(): Stat {
    return {
      kind: "fifo",
      size: this.buffered,
      createdAt: this.createdAt,
      modifiedAt: Date.now(),
    };
  }

  public closeRead(): void {
    if (this.readerCount === 0) return;
    if (--this.readerCount === 0) this.wake(this.writeWaiters); // → EPIPE
  }

  public closeWrite(): void {
    if (this.writerCount === 0) return;
    if (--this.writerCount === 0) this.wake(this.readWaiters); // → EOF
  }

  private park(queue: Waker[], signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = queue.indexOf(wake);
        if (i >= 0) queue.splice(i, 1);
        reject(eintr(this.description));
      };
      const wake: Waker = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };

      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(wake);
    });
  }

  private wake(queue: Waker[]): void {
    for (const w of queue.splice(0)) w();
  }
}

export class PipeReadEnd implements OpenFile {
  public readonly seekable = false;
  private closed = false;

  private readonly buffer: PipeBuffer;

  public constructor(buffer: PipeBuffer) {
    this.buffer = buffer;
  }

  public get description(): string {
    return this.buffer.description;
  }

  public async read(_offset: number, length: number, signal?: AbortSignal) {
    if (this.closed) throw ebadf(this.description);
    return this.buffer.read(length, signal);
  }

  public async write(
    _offset: number,
    _data: Bytes,
    _signal?: AbortSignal,
  ): Promise<number> {
    throw ebadf(`${this.description}: read end is not writable`);
  }

  public async stat(): Promise<Stat> {
    return this.buffer.stat();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffer.closeRead();
  }
}

export class PipeWriteEnd implements OpenFile {
  public readonly seekable = false;
  private closed = false;

  private readonly buffer: PipeBuffer;

  public constructor(buffer: PipeBuffer) {
    this.buffer = buffer;
  }

  public get description(): string {
    return this.buffer.description;
  }

  public async read(
    _offset: number,
    _length: number,
    _signal?: AbortSignal,
  ): Promise<Bytes> {
    throw ebadf(`${this.description}: read end is not readible`);
  }

  public async write(
    _offset: number,
    data: Bytes,
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.closed) throw ebadf(this.description);
    return this.buffer.write(data, signal);
  }

  public async stat(): Promise<Stat> {
    return this.buffer.stat();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffer.closeWrite();
  }
}

export function createPipe(): { read: PipeReadEnd; write: PipeWriteEnd } {
  const buffer = new PipeBuffer();
  return { read: new PipeReadEnd(buffer), write: new PipeWriteEnd(buffer) };
}
