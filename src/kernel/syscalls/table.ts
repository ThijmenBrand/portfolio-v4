import type { KernelContext } from "../context";
import type { EventHandler, EventType } from "../events/types";
import type { FdInfo, OpenFlags, Whence } from "../fs/openfile";
import type { DirEntry, Stat, StatResult } from "../fs/types";
import type { Signal } from "../proc/signals";
import type {
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
import { processSyscalls } from "./process";
import { timersSyscalls } from "./timers";
import { windowSyscalls } from "./window";

export interface SyscallTable {
  spawn(callerPid: Pid, path: string, args?: string[]): Pid;
  exit(callerPid: Pid, code: number): void;
  createWindow(callerPid: Pid, options: WindowOptions): WindowHandle;
  setWindowTitle(callerPid: Pid, windowId: WindowId, title: string): void;
  listWindows(callerPid: Pid): Array<WindowInfo>;
  focusWindow(callerPid: Pid, windowId: WindowId): void;
  setMinimized(callerPid: Pid, windowId: WindowId, minimized: boolean): void;
  closeWindow(callerPid: Pid, windowId: WindowId): void;
  onWindowCloseRequest(
    callerPid: Pid,
    windowId: WindowId,
    db: () => void,
  ): void;
  getDisplayRoot(callerPid: Pid): HTMLElement;
  getTaskbarRoot(callerPid: Pid): HTMLElement;
  getWorkArea(callerPid: Pid): Rect;
  reserveStrut(callerPid: Pid, edge: StrutEdge, size: number): number;
  releaseStrut(callerPid: Pid, resourceId: number): void;
  list(callerPid: Pid): ProcessInfo[];
  getSignal(callerPid: Pid): ProcessSignal;
  onSignal(callerPid: Pid, signal: Signal, handler: () => void): void;
  wait(callerPid: Pid, targetPid: Pid): Promise<Termination>;
  setInterval(callerPid: Pid, callback: () => void, ms: number): number;
  clearInterval(callerPid: Pid, id: number): void;
  setTimeout(callerPid: Pid, callback: () => void, ms: number): number;
  clearTimeout(callerPid: Pid, id: number): void;
  kill(callerPid: Pid, targetPid: Pid, signal: Signal): void;
  history(callerPid: Pid): readonly ExitRecord[];
  subscribe<T extends EventType>(
    callerPid: Pid,
    types: readonly T[],
    handler: EventHandler<T>,
  ): () => void;
  stat(callerPid: Pid, path: string): Promise<StatResult>;
  readDir(callerPid: Pid, path: string): Promise<DirEntry[]>;
  readFile(callerPid: Pid, path: string): Promise<Uint8Array>;
  writeFile(callerPid: Pid, path: string, data: Uint8Array): Promise<void>;
  mkdir(callerPid: Pid, path: string): Promise<void>;
  rmdir(callerPid: Pid, path: string): Promise<void>;
  unlink(callerPid: Pid, path: string): Promise<void>;
  open(callerPid: Pid, path: string, flags: OpenFlags): Promise<number>;
  close(callerPid: Pid, fd: number): Promise<void>;
  read(callerPid: Pid, fd: number, length: number): Promise<Uint8Array>;
  write(callerPid: Pid, fd: number, data: Uint8Array): Promise<number>;
  seek(
    callerPid: Pid,
    fd: number,
    offset: number,
    whence: Whence,
  ): Promise<number>;
  dup(callerPid: Pid, fd: number, to?: number): number;
  fstat(callerPid: Pid, fd: number): Promise<Stat>;
  listFds(callerPid: Pid): FdInfo[];
  chdir(callerPid: Pid, path: string): Promise<void>;
  cwd(callerPid: Pid): string;
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
