import type {
  ExitRecord,
  KernelInterface,
  ProcessInfo,
  ProcessSignal,
  Signal,
  Termination,
} from "./types";
import type { WindowHandle, WindowOptions } from "./windows/types";

export interface SyscallTarget {
  spawn(path: string, args: string[], parentPid: number): number;
  exit(pid: number, code: number): void;
  createWindow(options: WindowOptions, ownerPid: number): WindowHandle;
  setWindowTitle(windowId: number, pid: number, title: string): void;
  closeWindow(windowId: number, pid: number): void;
  onWindowCloseRequest(
    windowId: number,
    pid: number,
    callback: () => void,
  ): void;
  getDisplayRoot(pid: number): HTMLElement;
  ps(): ProcessInfo[];
  getProcessSignal(pid: number): ProcessSignal;
  onSignal(pid: number, signal: Signal, handler: () => void): void;
  wait(pid: number, callerPid: number): Promise<Termination>;
  setInterval(pid: number, callback: () => void, ms: number): number;
  clearInterval(pid: number, id: number): void;
  kill(pid: number, signal: Signal, senderPid: number): void;
  history(): readonly ExitRecord[];
}

export function createWindowHandle(
  target: SyscallTarget,
  pid: number,
  windowId: number,
  body: HTMLElement,
): WindowHandle {
  return {
    id: windowId,
    body: body,
    setTitle: (title: string) => target.setWindowTitle(windowId, pid, title),
    close: () => target.closeWindow(windowId, pid),
    onCloseRequest: (callback: () => void) =>
      target.onWindowCloseRequest(windowId, pid, callback),
  };
}

export function createSyscalls(
  target: SyscallTarget,
  pid: number,
): KernelInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
    },
    windows: {
      create: (options: WindowOptions) => target.createWindow(options, pid),
    },
    process: {
      get signal() {
        return target.getProcessSignal(pid);
      },
      get pid() {
        return pid;
      },
      spawn: (path: string, args: string[] = []) =>
        target.spawn(path, args, pid),
      wait: (childPid: number) => target.wait(childPid, pid),
      exit: (code?: number) => target.exit(pid, code ?? 0),
      list: () => target.ps(),
      onSignal: (signal: Signal, handler: () => void) =>
        target.onSignal(pid, signal, handler),
      kill: (targetPid: number, signal: Signal) =>
        target.kill(targetPid, signal, pid),
      history: () => target.history(),
    },
    timers: {
      setInterval: (callback: () => void, ms: number) =>
        target.setInterval(pid, callback, ms),
      clearInterval: (id: number) => target.clearInterval(pid, id),
    },
  };
}
