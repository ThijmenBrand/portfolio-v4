import type { KernelInterface, WindowHandle, WindowOptions } from "./types";

export interface SyscallTarget {
  spawn(path: string, args: string[], parentPid: number): number;
  exit(pid: number, code: number): void;
  createWindow(options: WindowOptions, ownerPid: number): WindowHandle;
  getDisplayRoot(pid: number): HTMLElement;
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
