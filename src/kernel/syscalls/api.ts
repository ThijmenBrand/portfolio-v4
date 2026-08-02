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
import type { WindowHandle, WindowInfo, WindowOptions } from "../windows/types";
import type { SyscallTable } from "./table";
import type { WindowHandleCommands } from "./window";

export interface KernelInterface {
  display: { root(): HTMLElement; taskbar(): HTMLElement };
  windows: {
    create(options: WindowOptions): WindowHandle;
    list(): WindowInfo[];
    focus(windowId: WindowId): void;
    setMinimized(windowId: WindowId, minimized: boolean): void;
  };
  process: {
    readonly signal: ProcessSignal;
    readonly pid: Pid;
    onSignal(signal: Signal, handler: () => void): void;
    wait(pid: Pid): Promise<Termination>;
    spawn(path: string, args?: string[]): Pid;
    exit(code?: number): void;
    list(): ProcessInfo[];
    kill(pid: Pid, signal: Signal, code?: number): void;
    history(): readonly ExitRecord[];
  };
  timers: {
    setInterval(callback: () => void, ms: number): number;
    clearInterval(id: number): void;
  };
  events: {
    subscribe<T extends EventType>(
      types: readonly T[],
      handler: EventHandler<T>,
    ): () => void;
  };
}

export function bindSyscalls(target: SyscallTable, pid: Pid): KernelInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
      taskbar: () => target.getTaskbarRoot(pid),
    },
    windows: {
      create: (options) => target.createWindow(pid, options),
      list: () => target.listWindows(pid),
      focus: (windowId) => target.focusWindow(pid, windowId),
      setMinimized: (windowId, minimized) =>
        target.setMinimized(pid, windowId, minimized),
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
