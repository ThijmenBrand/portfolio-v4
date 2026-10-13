import { eintr } from "../errors";
import type { EventHandler, EventType } from "../events/types";
import type { DirEntry, Stat, StatResult } from "../fs/types";
import type { FdInfo, OpenFlags, PipeFds, Whence } from "../io/openfile";
import type { Termios, Winsize } from "../io/pty";
import type { Signal } from "../proc/signals";
import type {
  Bytes,
  ExitRecord,
  KernelContext,
  LocationInfo,
  Pid,
  Process,
  ProcessInfo,
  ProcessSignal,
  Rect,
  StrutEdge,
  WaitOptions,
  WaitStatus,
  WindowId,
} from "../types";
import type {
  ElementWindowHandle,
  WindowInfo,
  WindowOptions,
} from "../windows/types";
import { apiSyscalls, type ApiRequest, type ApiResponse } from "./api-fetch";
import type { DialogOptions } from "../dialog/list";
import { clipboardSyscalls } from "./clipboard";
import { dialogSyscalls } from "./dialog";
import { displaySyscalls } from "./display";
import { eventsSyscalls } from "./events";
import { fdSyscalls } from "./fd";
import { shellSyscalls } from "./shell";
import type { StatusItemInfo, StatusItemSpec } from "./status";
import { fsSyscalls } from "./fs";
import { netSyscalls, type NetRequest, type NetResponse } from "./net";
import { processSyscalls, type Ids, type SpawnOptions } from "./process";
import { timersSyscalls } from "./timers";
import { windowSyscalls } from "./window";

export interface SyscallTable {
  spawn(
    callerPid: Pid,
    path: string,
    args?: string[],
    options?: SpawnOptions,
  ): Promise<Pid>;
  exit(callerPid: Pid, code: number): Promise<void>;
  createWindow(
    callerPid: Pid,
    options: WindowOptions,
  ): Promise<ElementWindowHandle>;
  /** Over-the-wire `windows.create`: claim the window made at exec. */
  claimWindow(callerPid: Pid, options: WindowOptions): Promise<WindowId>;
  setWindowTitle(
    callerPid: Pid,
    windowId: WindowId,
    title: string,
  ): Promise<void>;
  listWindows(callerPid: Pid): Promise<Array<WindowInfo>>;
  focusWindow(callerPid: Pid, windowId: WindowId): Promise<void>;
  setMinimized(
    callerPid: Pid,
    windowId: WindowId,
    minimized: boolean,
  ): Promise<void>;
  closeWindow(callerPid: Pid, windowId: WindowId): Promise<void>;
  onWindowCloseRequest(
    callerPid: Pid,
    windowId: WindowId,
    db: () => void,
  ): Promise<void>;
  getDisplayRoot(callerPid: Pid): Promise<HTMLElement>;
  getTaskbarRoot(callerPid: Pid): Promise<HTMLElement>;
  getWorkArea(callerPid: Pid): Promise<Rect>;
  reserveStrut(callerPid: Pid, edge: StrutEdge, size: number): Promise<number>;
  releaseStrut(callerPid: Pid, resourceId: number): Promise<void>;
  addStatusItem(
    callerPid: Pid,
    spec: StatusItemSpec,
    onSelect: (id: string) => void,
  ): Promise<number>;
  updateStatusItem(
    callerPid: Pid,
    id: number,
    patch: Partial<StatusItemSpec>,
  ): Promise<void>;
  removeStatusItem(callerPid: Pid, id: number): Promise<void>;
  listStatusItems(callerPid: Pid): Promise<StatusItemInfo[]>;
  activateStatusItem(callerPid: Pid, id: number, menuId: string): Promise<void>;
  list(callerPid: Pid): Promise<ProcessInfo[]>;
  getSignal(callerPid: Pid): ProcessSignal;
  onSignal(
    callerPid: Pid,
    signal: Signal,
    handler: () => void,
  ): Promise<() => void>;
  wait(
    callerPid: Pid,
    targetPid: Pid,
    options?: WaitOptions,
  ): Promise<WaitStatus>;
  setInterval(
    callerPid: Pid,
    callback: () => void,
    ms: number,
  ): Promise<number>;
  clearInterval(callerPid: Pid, id: number): Promise<void>;
  setTimeout(callerPid: Pid, callback: () => void, ms: number): Promise<number>;
  clearTimeout(callerPid: Pid, id: number): Promise<void>;
  kill(callerPid: Pid, targetPid: Pid, signal: Signal): Promise<void>;
  history(callerPid: Pid): Promise<readonly ExitRecord[]>;
  subscribe<T extends EventType>(
    callerPid: Pid,
    types: readonly T[],
    handler: EventHandler<T>,
  ): Promise<() => void>;
  stat(callerPid: Pid, path: string): Promise<StatResult>;
  readDir(callerPid: Pid, path: string): Promise<DirEntry[]>;
  readFile(callerPid: Pid, path: string): Promise<Bytes>;
  writeFile(callerPid: Pid, path: string, data: Bytes): Promise<void>;
  mkdir(callerPid: Pid, path: string): Promise<void>;
  rmdir(callerPid: Pid, path: string): Promise<void>;
  unlink(callerPid: Pid, path: string): Promise<void>;
  rename(callerPid: Pid, from: string, to: string): Promise<void>;
  open(callerPid: Pid, path: string, flags: OpenFlags): Promise<number>;
  close(callerPid: Pid, fd: number): Promise<void>;
  read(callerPid: Pid, fd: number, length: number): Promise<Bytes>;
  write(callerPid: Pid, fd: number, data: Bytes): Promise<number>;
  seek(
    callerPid: Pid,
    fd: number,
    offset: number,
    whence: Whence,
  ): Promise<number>;
  dup(callerPid: Pid, fd: number, to?: number): Promise<number>;
  fstat(callerPid: Pid, fd: number): Promise<Stat>;
  listFds(callerPid: Pid): Promise<FdInfo[]>;
  chdir(callerPid: Pid, path: string): Promise<void>;
  cwd(callerPid: Pid): Promise<string>;
  getenv(callerPid: Pid): Promise<Record<string, string>>;
  setenv(callerPid: Pid, name: string, value?: string): Promise<void>;
  ids(callerPid: Pid): Promise<Ids>;
  chmod(callerPid: Pid, path: string, mode: number): Promise<void>;
  chown(callerPid: Pid, path: string, uid: number, gid: number): Promise<void>;
  pipe(callerPid: Pid): Promise<PipeFds>;
  openpty(callerPid: Pid): Promise<{ master: number; slave: number }>;
  tcgetattr(callerPid: Pid, fd: number): Promise<Termios>;
  tcsetattr(callerPid: Pid, fd: number, changes: Partial<Termios>): Promise<void>;
  tcgetpgrp(callerPid: Pid, fd: number): Promise<Pid | null>;
  tcsetpgrp(callerPid: Pid, fd: number, pgid: Pid): Promise<void>;
  getWinsize(callerPid: Pid, fd: number): Promise<Winsize>;
  setWinsize(callerPid: Pid, fd: number, size: Winsize): Promise<void>;
  setsid(callerPid: Pid): Promise<Pid>;
  openExternal(callerPid: Pid, url: string): Promise<void>;
  getLocation(callerPid: Pid): Promise<LocationInfo>;
  download(callerPid: Pid, path: string): Promise<void>;
  apiFetch(callerPid: Pid, path: string, request?: ApiRequest): Promise<ApiResponse>;
  netFetch(callerPid: Pid, url: string, request?: NetRequest): Promise<NetResponse>;
  openDialog(callerPid: Pid, options: DialogOptions): Promise<string | null>;
  clipboardWrite(callerPid: Pid, text: string): Promise<void>;
  clipboardRead(callerPid: Pid): Promise<string>;
}

export function createSyscallTable(ctx: KernelContext): SyscallTable {
  return gateStopped(ctx, {
    ...processSyscalls(ctx),
    ...windowSyscalls(ctx),
    ...timersSyscalls(ctx),
    ...displaySyscalls(ctx),
    ...eventsSyscalls(ctx),
    ...fsSyscalls(ctx),
    ...fdSyscalls(ctx),
    ...shellSyscalls(ctx),
    ...apiSyscalls(ctx),
    ...netSyscalls(ctx),
    ...dialogSyscalls(ctx),
    ...clipboardSyscalls(ctx),
  });
}

/**
 * A stopped process's syscalls park here until SIGCONT (EINTR if it dies
 * first). One place every caller routes through: in-page apps and the wire.
 * ponytail: a call already in flight finishes; JS can't be preempted.
 */
function gateStopped(ctx: KernelContext, table: SyscallTable): SyscallTable {
  type Call = (pid: Pid, ...args: unknown[]) => unknown;
  const gated: Record<string, Call> = {};
  for (const [name, call] of Object.entries(table) as [string, Call][]) {
    gated[name] =
      name === "getSignal" // synchronous, and only reads
        ? call
        : (pid, ...args) => {
            const proc = ctx.processes.get(pid);
            if (!proc?.stopped) return call(pid, ...args);
            return untilContinued(proc).then(() => call(pid, ...args));
          };
  }
  return gated as unknown as SyscallTable;
}

function untilContinued(proc: Process): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = proc.abortController.signal;
    const onAbort = () => reject(eintr(proc.pid));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    proc.continueWaiters.push(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
