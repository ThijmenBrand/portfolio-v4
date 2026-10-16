import type { OpenFile } from "../io/openfile";
import type { Bytes } from "../types";
import type { Stat } from "./types";

/**
 * What VFS.open actually hands back: the mount's own open file, plus the two
 * things only the VFS knows about it.
 *
 * It exists because a driver may supply its own open() (procfs does, and so
 * does the server-backed one). Wiring the change hook into VfsFile instead
 * would quietly skip those drivers, so a write to them would never reach
 * anything watching the filesystem -- the file would appear but never seem to
 * change.
 */
export class MountedFile implements OpenFile {
  private readonly inner: OpenFile;
  private readonly onWritten?: () => void;

  /** On a server-backed mount: filesystem code may not touch it, even
   *  through a descriptor it inherited (proc/fd.ts). */
  public readonly remote: boolean;

  private closed = false;

  public constructor(
    inner: OpenFile,
    options: { remote: boolean; onWritten?: () => void },
  ) {
    this.inner = inner;
    this.remote = options.remote;
    this.onWritten = options.onWritten;
  }

  public get description(): string {
    return this.inner.description;
  }

  public get seekable(): boolean {
    return this.inner.seekable;
  }

  public read(offset: number, length: number, signal?: AbortSignal): Promise<Bytes> {
    return this.inner.read(offset, length, signal);
  }

  public write(offset: number, data: Bytes, signal?: AbortSignal): Promise<number> {
    return this.inner.write(offset, data, signal);
  }

  public stat(): Promise<Stat> {
    return this.inner.stat();
  }

  /** One notification per write session, after the bytes are committed. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.inner.close();
    } finally {
      this.onWritten?.();
    }
  }
}
