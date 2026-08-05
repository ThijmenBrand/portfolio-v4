import type { KernelContext } from "../context";
import type { OpenFlags, Whence } from "../fs/openfile";
import {
  closeFd,
  dupFd,
  fstatFd,
  listFds,
  openFd,
  readFd,
  seekFd,
  writeFd,
} from "../proc/fd";
import type { Pid } from "../types";
import type { SyscallTable } from "./table";

export function fdSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  "open" | "close" | "read" | "write" | "seek" | "dup" | "fstat" | "listFds"
> {
  return {
    open: (callerPid: Pid, path: string, flags: OpenFlags) =>
      openFd(ctx, callerPid, path, flags),
    close: (callerPid: Pid, fd: number) => closeFd(ctx, callerPid, fd),
    read: (callerPid: Pid, fd: number, length: number) =>
      readFd(ctx, callerPid, fd, length),
    write: (callerPid: Pid, fd: number, data: Uint8Array) =>
      writeFd(ctx, callerPid, fd, data),
    seek: (callerPid: Pid, fd: number, offset: number, whence: Whence) =>
      seekFd(ctx, callerPid, fd, offset, whence),
    dup: (callerPid: Pid, fd: number, to?: number) =>
      dupFd(ctx, callerPid, fd, to),
    fstat: (callerPid: Pid, fd: number) => fstatFd(ctx, callerPid, fd),
    listFds: (callerPid: Pid) => listFds(ctx, callerPid),
  };
}
