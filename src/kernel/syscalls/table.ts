import type { KernelContext } from "../context";
import type { EventHandler, EventType } from "../events/types";
import type { DirEntry, Stat, StatResult } from "../fs/types";
import type { FdInfo, OpenFlags, PipeFds, Whence } from "../io/openfile";
import type { Signal } from "../proc/signals";
import type {
  Bytes,
  ExitRecord,
  Pid,
  ProcessInfo,
  ProcessSignal,
  Rect,
  StrutEdge,
  Termination,
  WindowId,
} from "../types";
import type { WindowHandle, WindowInfo, WindowOptions } from "../windows/types";
import { displaySyscalls } from "./display";
import { eventsSyscalls } from "./events";
import { fdSyscalls } from "./fd";
import { fsSyscalls } from "./fs";
import { processSyscalls, type SpawnOptions } from "./process";
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
  createWindow(callerPid: Pid, options: WindowOptions): Promise<WindowHandle>;
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
  list(callerPid: Pid): Promise<ProcessInfo[]>;
  getSignal(callerPid: Pid): Promise<ProcessSignal>;
  onSignal(
    callerPid: Pid,
    signal: Signal,
    handler: () => void,
  ): Promise<() => void>;
  wait(callerPid: Pid, targetPid: Pid): Promise<Termination>;
  setInterval(
    callerPid: Pid,
    callback: () => void,
    ms: number,
  ): Promise<number>;
  clearInterval(callerPid: Pid, id: number): Promise<void>;
  setTimeout(
    callerPid: Pid,
    callback: () => void,
    ms: number,
  ): Promise<number>;
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
  pipe(callerPid: Pid): Promise<PipeFds>;
  openpty(callerPid: Pid): Promise<{ master: number; slave: number }>;
}

export function createSyscallTable(ctx: KernelContext): SyscallTable {
  return {
    ...processSyscalls(ctx),
    ...windowSyscalls(ctx),
    ...timersSyscalls(ctx),
    ...displaySyscalls(ctx),
    ...eventsSyscalls(ctx),
    ...fsSyscalls(ctx),
    ...fdSyscalls(ctx),
  };
}
