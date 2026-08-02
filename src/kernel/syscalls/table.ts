import type { KernelContext } from "../context";
import type { EventHandler, EventType } from "../events/types";
import type { Signal } from "../proc/signals";
import type {
  ExitRecord,
  Pid,
  ProcessInfo,
  ProcessSignal,
  Termination,
  WindowId,
} from "../types";
import type { WindowHandle, WindowOptions } from "../windows/types";
import { displaySyscalls } from "./display";
import { eventsSyscalls } from "./events";
import { processSyscalls } from "./process";
import { timersSyscalls } from "./timers";
import { windowSyscalls } from "./window";

export interface SyscallTable {
  spawn(callerPid: Pid, path: string, args?: string[]): Pid;
  exit(callerPid: Pid, code: number): void;
  createWindow(callerPid: Pid, options: WindowOptions): WindowHandle;
  setWindowTitle(callerPid: Pid, windowId: WindowId, title: string): void;
  closeWindow(callerPid: Pid, windowId: WindowId): void;
  onWindowCloseRequest(
    callerPid: Pid,
    windowId: WindowId,
    db: () => void,
  ): void;
  getDisplayRoot(callerPid: Pid): HTMLElement;
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
}

export function createSyscallTable(ctx: KernelContext): SyscallTable {
  return {
    ...processSyscalls(ctx),
    ...windowSyscalls(ctx),
    ...timersSyscalls(ctx),
    ...displaySyscalls(ctx),
    ...eventsSyscalls(ctx),
  };
}
