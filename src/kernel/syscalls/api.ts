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
import type { SpawnOptions } from "./process";
import type { SyscallTable } from "./table";
import type { WindowHandleCommands } from "./window";

export interface KernelInterface {
  display: {
    root(): HTMLElement;
    taskbar(): HTMLElement;
    workArea(): Rect;
    reserveStrut(edge: StrutEdge, size: number): number;
    releaseStrut(resourceId: number): void;
  };
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
    spawn(path: string, args?: string[], options?: SpawnOptions): Pid;
    exit(code?: number): void;
    list(): ProcessInfo[];
    kill(pid: Pid, signal: Signal, code?: number): void;
    history(): readonly ExitRecord[];
    chdir(path: string): Promise<void>;
    cwd(): string;
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
  fs: {
    readFile(path: string): Promise<Bytes>;
    writeFile(path: string, data: Bytes): Promise<void>;
    readTextFile(path: string): Promise<string>;
    writeTextFile(path: string, text: string): Promise<void>;
    readdir(path: string): Promise<DirEntry[]>;
    stat(path: string): Promise<StatResult>;
    mkdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };
  io: {
    open(path: string, flags: OpenFlags): Promise<number>;
    close(fd: number): Promise<void>;
    read(fd: number, length: number): Promise<Bytes>;
    write(fd: number, data: Bytes): Promise<number>;
    seek(fd: number, offset: number, whence?: Whence): Promise<number>;
    dup(fd: number, to?: number): number;
    fstat(fd: number): Promise<Stat>;
    listFds(): FdInfo[];
    pipe(): Promise<PipeFds>;
    openpty(): Promise<{ master: number; slave: number }>;
  };
}

export function bindSyscalls(target: SyscallTable, pid: Pid): KernelInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
      taskbar: () => target.getTaskbarRoot(pid),
      workArea: () => target.getWorkArea(pid),
      reserveStrut: (edge, size) => target.reserveStrut(pid, edge, size),
      releaseStrut: (resourceId) => target.releaseStrut(pid, resourceId),
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
      spawn: (path, args, options) => target.spawn(pid, path, args, options),
      wait: (childPid) => target.wait(pid, childPid),
      exit: (code?) => target.exit(pid, code ?? 0),
      list: () => target.list(pid),
      onSignal: (signal, handler) => target.onSignal(pid, signal, handler),
      kill: (targetPid, signal) => target.kill(pid, targetPid, signal),
      history: () => target.history(pid),
      chdir: (path: string) => target.chdir(pid, path),
      cwd: () => target.cwd(pid),
    },
    timers: {
      setInterval: (callback, ms) => target.setInterval(pid, callback, ms),
      clearInterval: (id: number) => target.clearInterval(pid, id),
    },
    events: {
      subscribe: (types, handler) => target.subscribe(pid, types, handler),
    },
    fs: {
      readFile: (path) => target.readFile(pid, path),
      writeFile: (path, data) => target.writeFile(pid, path, data),
      readTextFile: async (path) =>
        new TextDecoder().decode(await target.readFile(pid, path)),
      writeTextFile: (path, text) =>
        target.writeFile(pid, path, new TextEncoder().encode(text)),
      readdir: (path) => target.readDir(pid, path),
      stat: (path) => target.stat(pid, path),
      mkdir: (path) => target.mkdir(pid, path),
      unlink: (path) => target.unlink(pid, path),
    },
    io: {
      open: (path, flags) => target.open(pid, path, flags),
      close: (fd) => target.close(pid, fd),
      read: (fd, length) => target.read(pid, fd, length),
      write: (fd, data) => target.write(pid, fd, data),
      seek: (fd, offset, whence = "set") =>
        target.seek(pid, fd, offset, whence),
      dup: (fd, to) => target.dup(pid, fd, to),
      fstat: (fd) => target.fstat(pid, fd),
      listFds: () => target.listFds(pid),
      pipe: () => target.pipe(pid),
      openpty: () => target.openpty(pid),
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
