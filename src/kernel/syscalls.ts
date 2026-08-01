import type { KernelInterface, WindowHandle, WindowOptions } from "./types";

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
      get pid() {
        return pid;
      },
      spawn: (path: string, args: string[] = []) =>
        target.spawn(path, args, pid),
      exit: (code?: number) => target.exit(pid, code ?? 0),
    },
  };
}
