import { ebadf, ebusy, emfile, logError } from "../errors";
import type {
  FdInfo,
  OpenFile,
  OpenFileDescription,
  OpenFlags,
} from "../fs/openfile";

export class FdTable {
  private static readonly MAX_FDS = 256;
  private readonly entries = new Map<number, OpenFileDescription>();

  public allocate(file: OpenFile, flags: OpenFlags): number {
    const fd = this.lowestFree();
    this.entries.set(fd, {
      file,
      flags,
      offset: 0,
      refs: 1,
      lock: Promise.resolve(),
    });
    return fd;
  }

  public list(): FdInfo[] {
    return Array.from(this.entries, ([fd, ofd]) => ({
      fd,
      description: ofd.file.description,
      flags: ofd.flags,
      offset: ofd.offset,
      refs: ofd.refs,
      seekable: ofd.file.seekable,
    }));
  }

  public get(fd: number): OpenFileDescription {
    const ofd = this.entries.get(fd);
    if (!ofd) throw ebadf(`Invalid file descriptor: ${fd}`);
    return ofd;
  }

  public async close(fd: number): Promise<void> {
    const ofd = this.get(fd);
    this.entries.delete(fd);
    if (--ofd.refs === 0) await ofd.file.close();
  }

  public async closeAll(): Promise<void> {
    const ofds = Array.from(this.entries.values());
    this.entries.clear();

    const results = await Promise.allSettled(
      ofds.map(async (ofd) => {
        if (--ofd.refs === 0) await ofd.file.close();
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") logError(`closeAll: ${r.reason}`);
    }
  }

  public dup(fd: number, to?: number): number {
    const ofd = this.get(fd);

    if (to === undefined) {
      const target = this.lowestFree();
      ofd.refs++;
      this.entries.set(target, ofd);
      return target;
    }

    if (to === fd) return fd;
    if (to < 0 || to >= FdTable.MAX_FDS) throw ebadf(to);

    const previous = this.entries.get(to);
    ofd.refs++;
    this.entries.set(to, ofd);

    if (previous && --previous.refs === 0) {
      void previous.file.close().catch(logError);
    }

    return to;
  }

  public inheritFrom(parent: FdTable): void {
    if (this.entries.size > 0) throw ebusy("InheritFrom: table is not empty");
    for (const [fd, ofd] of parent.entries) {
      ofd.refs++;
      this.entries.set(fd, ofd);
    }
  }

  private lowestFree(): number {
    for (let fd = 0; fd < FdTable.MAX_FDS; fd++) {
      if (!this.entries.has(fd)) return fd;
    }
    throw emfile();
  }
}
