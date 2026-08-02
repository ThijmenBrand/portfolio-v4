import type { Signal } from "../proc/signals";
import type { KernelInterface, Pid, WindowId } from "../types";
import type { WindowHandle, WindowOptions } from "../windows/types";
import type { SyscallTable } from "./table";
import type { WindowHandleCommands } from "./window";

export function bindSyscalls(target: SyscallTable, pid: Pid): KernelInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
    },
    windows: {
      create: (options: WindowOptions) => target.createWindow(pid, options),
    },
    process: {
      get signal() {
        return target.getSignal(pid);
      },
      get pid() {
        return pid;
      },
      spawn: (path: string, args: string[] = []) =>
        target.spawn(pid, path, args),
      wait: (childPid: Pid) => target.wait(pid, childPid),
      exit: (code?: number) => target.exit(pid, code ?? 0),
      list: () => target.list(pid),
      onSignal: (signal: Signal, handler: () => void) =>
        target.onSignal(pid, signal, handler),
      kill: (targetPid: Pid, signal: Signal) =>
        target.kill(pid, targetPid, signal),
      history: () => target.history(pid),
    },
    timers: {
      setInterval: (callback: () => void, ms: number) =>
        target.setInterval(pid, callback, ms),
      clearInterval: (id: number) => target.clearInterval(pid, id),
    },
  };
}

export function bindWindowHandle(
  pid: Pid,
  target: WindowHandleCommands,
  windowId: WindowId,
  body: HTMLElement,
): WindowHandle {
  return {
    id: windowId,
    body: body,
    setTitle: (title: string) => target.setWindowTitle(pid, windowId, title),
    close: () => target.closeWindow(pid, windowId),
    onCloseRequest: (callback: () => void) =>
      target.onWindowCloseRequest(pid, windowId, callback),
  };
}
