import type { KernelInterface, Pid, WindowId } from "../types";
import type { WindowHandle } from "../windows/types";
import type { SyscallTable } from "./table";
import type { WindowHandleCommands } from "./window";

export function bindSyscalls(target: SyscallTable, pid: Pid): KernelInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
    },
    windows: {
      create: (options) => target.createWindow(pid, options),
    },
    process: {
      get signal() {
        return target.getSignal(pid);
      },
      get pid() {
        return pid;
      },
      spawn: (path, args) => target.spawn(pid, path, args),
      wait: (childPid) => target.wait(pid, childPid),
      exit: (code?) => target.exit(pid, code ?? 0),
      list: () => target.list(pid),
      onSignal: (signal, handler) => target.onSignal(pid, signal, handler),
      kill: (targetPid, signal) => target.kill(pid, targetPid, signal),
      history: () => target.history(pid),
    },
    timers: {
      setInterval: (callback, ms) => target.setInterval(pid, callback, ms),
      clearInterval: (id: number) => target.clearInterval(pid, id),
    },
    events: {
      subscribe: (types, handler) => target.subscribe(pid, types, handler),
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
