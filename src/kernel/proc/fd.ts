import { ebadf, einval, enotty, eperm, espipe, logError } from "../errors";
import { resolveFrom } from "../fs/path";
import type { Stat } from "../fs/types";
import type {
  OpenFileDescription,
  OpenFlags,
  FdInfo,
  Whence,
  PipeFds,
} from "../io/openfile";
import { createPipe } from "../io/pipe";
import { createPty, PtyEnd, type Termios, type Tty, type Winsize } from "../io/pty";
import { signalGroup } from "./signals";
import { requireAlive } from "../syscalls/guards";
import type { Bytes, KernelContext, Pid } from "../types";

function withOffset<T>(
  ofd: OpenFileDescription,
  op: () => Promise<T>,
): Promise<T> {
  const run = ofd.lock.then(
    () => op(),
    () => op(),
  );
  ofd.lock = run.catch(() => {});
  return run;
}

function description(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
): OpenFileDescription {
  return requireAlive(ctx, pid).files.get(fd);
}

export async function openFd(
  ctx: KernelContext,
  pid: Pid,
  path: string,
  flags: OpenFlags,
): Promise<number> {
  const proc = requireAlive(ctx, pid);

  const file = await ctx.fs.open(resolveFrom(proc.cwd, path), flags, proc);
  try {
    return proc.files.allocate(file, flags);
  } catch (e) {
    await file.close().catch(logError);
    throw e;
  }
}

export async function closeFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
): Promise<void> {
  await requireAlive(ctx, pid).files.close(fd);
}

export async function readFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  length: number,
): Promise<Bytes> {
  const proc = requireAlive(ctx, pid);
  const ofd = proc.files.get(fd);

  if (!ofd.flags.read) throw ebadf(`fd ${fd} is not open for reading`);
  if (length < 0) throw einval(`Invalid read length: ${length}`);
  if (length === 0) return new Uint8Array(0);

  const signal = proc.abortController.signal;

  const run = async () => {
    const chunk = await ofd.file.read(ofd.offset, length, signal);
    ofd.offset += chunk.length;
    return chunk;
  };

  return ofd.file.seekable ? withOffset(ofd, run) : run();
}

export async function writeFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  data: Bytes,
): Promise<number> {
  const proc = requireAlive(ctx, pid);
  const ofd = proc.files.get(fd);

  if (!ofd.flags.write) throw ebadf(`fd ${fd} is not open for writing`);
  if (data.length === 0) return 0;

  const signal = proc.abortController.signal;

  const run = async () => {
    if (ofd.flags.append) ofd.offset = (await ofd.file.stat()).size;
    const written = await ofd.file.write(ofd.offset, data, signal);
    ofd.offset += written;
    return written;
  };

  return ofd.file.seekable ? withOffset(ofd, run) : run();
}

export function listFds(ctx: KernelContext, pid: Pid, target?: Pid): FdInfo[] {
  const caller = requireAlive(ctx, pid);
  if (target === undefined || target === pid) return caller.files.list();
  if (!caller.privileged) throw eperm(pid, "listFds");
  return requireAlive(ctx, target).files.list();
}

export async function seekFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  offset: number,
  whence: Whence,
): Promise<number> {
  const ofd = description(ctx, pid, fd);
  if (!ofd.file.seekable) throw espipe(fd);

  return withOffset(ofd, async () => {
    let base: number | undefined;
    if (whence === "set") {
      base = 0;
    } else if (whence === "cur") {
      base = ofd.offset;
    } else if (whence === "end") {
      base = (await ofd.file.stat()).size;
    } else {
      throw einval(`Invalid whence: ${whence}`);
    }

    const next = base + offset;
    if (next < 0) throw einval(`Invalid seek offset: ${next}`);

    ofd.offset = next;
    return next;
  });
}

export function dupFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  to?: number,
): number {
  return requireAlive(ctx, pid).files.dup(fd, to);
}

export async function fstatFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
): Promise<Stat> {
  return description(ctx, pid, fd).file.stat();
}

export async function pipeFd(ctx: KernelContext, pid: Pid): Promise<PipeFds> {
  const proc = requireAlive(ctx, pid);
  const { read, write } = createPipe();

  const readFd = proc.files.allocate(read, { read: true });
  try {
    return { read: readFd, write: proc.files.allocate(write, { write: true }) };
  } catch (e) {
    await proc.files.close(readFd).catch(logError);
    await write.close().catch(logError);
    throw e;
  }
}

export async function ptyFd(
  ctx: KernelContext,
  pid: Pid,
): Promise<{ master: number; slave: number }> {
  const proc = requireAlive(ctx, pid);
  const { master, slave } = createPty((pgid, signal) =>
    signalGroup(ctx, pgid, signal),
  );

  const readFd = proc.files.allocate(master, { read: true, write: true });
  try {
    return {
      master: readFd,
      slave: proc.files.allocate(slave, { write: true, read: true }),
    };
  } catch (e) {
    await proc.files.close(readFd).catch(logError);
    await slave.close().catch(logError);
    throw e;
  }
}

function ttyOf(ctx: KernelContext, pid: Pid, fd: number): Tty {
  const { file } = description(ctx, pid, fd);
  if (!(file instanceof PtyEnd)) throw enotty(fd);
  return file.tty;
}

export function tcgetattr(ctx: KernelContext, pid: Pid, fd: number): Termios {
  return { ...ttyOf(ctx, pid, fd).termios };
}

/** Only the flags we know, only booleans: this comes off the wire. */
export function tcsetattr(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  changes: Partial<Termios>,
): void {
  const tty = ttyOf(ctx, pid, fd);
  const known: Partial<Termios> = {};
  for (const key of ["echo", "icanon", "isig"] as const) {
    const value = changes?.[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw einval(`tcsetattr ${key}`);
    known[key] = value;
  }
  tty.setAttr(known);
}

export function tcgetpgrp(ctx: KernelContext, pid: Pid, fd: number): Pid | null {
  return ttyOf(ctx, pid, fd).foreground ?? null;
}

/** The new foreground group must be in the caller's session, like tcsetpgrp(3). */
export function tcsetpgrp(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  pgid: Pid,
): void {
  const tty = ttyOf(ctx, pid, fd);
  const caller = requireAlive(ctx, pid);
  const inSession = ctx.processes
    .inGroup(pgid)
    .some((member) => member.sid === caller.sid);
  if (!inSession) throw eperm(pid, "tcsetpgrp");
  tty.foreground = pgid;
}

export function getWinsize(ctx: KernelContext, pid: Pid, fd: number): Winsize {
  return { ...ttyOf(ctx, pid, fd).winsize };
}

export function setWinsize(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  size: Winsize,
): void {
  const tty = ttyOf(ctx, pid, fd);
  const ok = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  if (!ok(size?.rows) || !ok(size?.cols)) throw einval("winsize");
  tty.setWinsize({ rows: size.rows, cols: size.cols });
}
