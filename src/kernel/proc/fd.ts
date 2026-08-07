import type { KernelContext } from "../context";
import { ebadf, einval, eperm, espipe, logError } from "../errors";
import type {
  FdInfo,
  OpenFileDescription,
  OpenFlags,
  Whence,
} from "../fs/openfile";
import { at } from "../fs/path";
import type { Stat } from "../fs/types";
import { requireAlive } from "../syscalls/guards";
import type { Pid } from "../types";

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

  const file = await ctx.fs.open(at(proc, path), flags);
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
): Promise<Uint8Array> {
  const proc = requireAlive(ctx, pid);
  const ofd = proc.files.get(fd);

  if (!ofd.flags.read) throw ebadf(`fd ${fd} is not open for reading`);
  if (length < 0) throw einval(`Invalid read length: ${length}`);
  if (length === 0) return new Uint8Array(0);

  const signal = proc.abortController.signal;
  return withOffset(ofd, async () => {
    const chunk = await ofd.file.read(ofd.offset, length, signal);
    ofd.offset += chunk.length;
    return chunk;
  });
}

export async function writeFd(
  ctx: KernelContext,
  pid: Pid,
  fd: number,
  data: Uint8Array,
): Promise<number> {
  const proc = requireAlive(ctx, pid);
  const ofd = proc.files.get(fd);

  if (!ofd.flags.write) throw ebadf(`fd ${fd} is not open for writing`);
  if (data.length === 0) return 0;

  const signal = proc.abortController.signal;

  return withOffset(ofd, async () => {
    if (ofd.flags.append) ofd.offset = (await ofd.file.stat()).size;

    const written = await ofd.file.write(ofd.offset, data, signal);
    ofd.offset += written;
    return written;
  });
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
