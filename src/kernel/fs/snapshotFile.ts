import { ebadf, einval, erofs } from "../errors";
import type { OpenFile } from "./openfile";
import type { Stat } from "./types";

export class SnapshotFile implements OpenFile {
  private readonly bytes: Uint8Array;
  private readonly meta: Stat;

  public readonly description: string;
  public readonly seekable = true;

  private closed = false;

  constructor(bytes: Uint8Array, meta: Stat, description: string) {
    this.bytes = bytes;
    this.meta = meta;
    this.description = description;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    if (offset < 0 || length < 0) throw einval(this.description);
    if (offset >= this.bytes.length) return new Uint8Array(0);
    return this.bytes.slice(offset, offset + length); // COPY — same rule as memfs
  }

  public async write(): Promise<number> {
    throw erofs(this.description);
  }
  public async stat(): Promise<Stat> {
    return this.meta;
  }
  public async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw ebadf(this.description);
  }
}
