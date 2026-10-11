import type { OpenFlags, Whence } from "../io/openfile";
import type { Termios, Winsize } from "../io/pty";
import {
  closeFd,
  dupFd,
  fstatFd,
  getWinsize,
  listFds,
  openFd,
  pipeFd,
  ptyFd,
  readFd,
  seekFd,
  setWinsize,
  tcgetattr,
  tcgetpgrp,
  tcsetattr,
  tcsetpgrp,
  writeFd,
} from "../proc/fd";
import type { Bytes, KernelContext, Pid } from "../types";
import type { SyscallTable } from "./table";

export function fdSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  | "open"
  | "close"
  | "read"
  | "write"
  | "seek"
  | "dup"
  | "fstat"
  | "listFds"
  | "pipe"
  | "openpty"
  | "tcgetattr"
  | "tcsetattr"
  | "tcgetpgrp"
  | "tcsetpgrp"
  | "getWinsize"
  | "setWinsize"
> {
  return {
    open: (callerPid: Pid, path: string, flags: OpenFlags) =>
      openFd(ctx, callerPid, path, flags),
    close: (callerPid: Pid, fd: number) => closeFd(ctx, callerPid, fd),
    read: (callerPid: Pid, fd: number, length: number) =>
      readFd(ctx, callerPid, fd, length),
    write: (callerPid: Pid, fd: number, data: Bytes) =>
      writeFd(ctx, callerPid, fd, data),
    seek: (callerPid: Pid, fd: number, offset: number, whence: Whence) =>
      seekFd(ctx, callerPid, fd, offset, whence),
    dup: async (callerPid: Pid, fd: number, to?: number) =>
      dupFd(ctx, callerPid, fd, to),
    fstat: (callerPid: Pid, fd: number) => fstatFd(ctx, callerPid, fd),
    listFds: async (callerPid: Pid) => listFds(ctx, callerPid),
    pipe: (callerPid: Pid) => pipeFd(ctx, callerPid),
    openpty: (callerPid: Pid) => ptyFd(ctx, callerPid),
    tcgetattr: async (callerPid: Pid, fd: number) =>
      tcgetattr(ctx, callerPid, fd),
    tcsetattr: async (callerPid: Pid, fd: number, changes: Partial<Termios>) =>
      tcsetattr(ctx, callerPid, fd, changes),
    tcgetpgrp: async (callerPid: Pid, fd: number) =>
      tcgetpgrp(ctx, callerPid, fd),
    tcsetpgrp: async (callerPid: Pid, fd: number, pgid: Pid) =>
      tcsetpgrp(ctx, callerPid, fd, pgid),
    getWinsize: async (callerPid: Pid, fd: number) =>
      getWinsize(ctx, callerPid, fd),
    setWinsize: async (callerPid: Pid, fd: number, size: Winsize) =>
      setWinsize(ctx, callerPid, fd, size),
  };
}
