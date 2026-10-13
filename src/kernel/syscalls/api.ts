import type { DialogOptions } from "../dialog/list";
import type { EventHandler, EventType } from "../events/types";
import type { DirEntry, Stat, StatResult } from "../fs/types";
import type { FdInfo, OpenFlags, PipeFds, Whence } from "../io/openfile";
import type { Termios, Winsize } from "../io/pty";
import type { Signal } from "../proc/signals";
import type {
  Bytes,
  ExitRecord,
  LocationInfo,
  Pid,
  ProcessInfo,
  ProcessSignal,
  Rect,
  StrutEdge,
  WaitOptions,
  WaitStatus,
  WindowId,
} from "../types";
import type {
  ElementWindowHandle,
  WindowHandle,
  WindowInfo,
  WindowOptions,
} from "../windows/types";
import type { ApiRequest, ApiResponse } from "./api-fetch";
import type { NetRequest, NetResponse } from "./net";
import type { Ids, SpawnOptions } from "./process";
import type { StatusItemInfo, StatusItemSpec } from "./status";
import type { SyscallTable } from "./table";
import type { WindowHandleCommands } from "./window";

export interface AppInterface {
  display: {
    workArea(): Promise<Rect>;
    addStatusItem(
      spec: StatusItemSpec,
      onSelect: (id: string) => void,
    ): Promise<number>;
    updateStatusItem(id: number, patch: Partial<StatusItemSpec>): Promise<void>;
    removeStatusItem(id: number): Promise<void>;
  };
  windows: {
    create(options: WindowOptions): Promise<WindowHandle>;
    list(): Promise<WindowInfo[]>;
    focus(windowId: WindowId): Promise<void>;
    setMinimized(windowId: WindowId, minimized: boolean): Promise<void>;
    /** Id-based handle operations: what a WindowHandle is built from over the wire. */
    setTitle(windowId: WindowId, title: string): Promise<void>;
    close(windowId: WindowId): Promise<void>;
    onCloseRequest(windowId: WindowId, callback: () => void): Promise<void>;
  };
  process: {
    readonly signal: ProcessSignal;
    readonly pid: Pid;
    onSignal(signal: Signal, handler: () => void): Promise<() => void>;
    /** `untraced`: also return when the child stops (reason "stopped"). */
    wait(pid: Pid, options?: WaitOptions): Promise<WaitStatus>;
    spawn(path: string, args?: string[], options?: SpawnOptions): Promise<Pid>;
    exit(code?: number): Promise<void>;
    list(): Promise<ProcessInfo[]>;
    kill(pid: Pid, signal: Signal): Promise<void>;
    history(): Promise<readonly ExitRecord[]>;
    chdir(path: string): Promise<void>;
    cwd(): Promise<string>;
    env(): Promise<Record<string, string>>;
    setenv(name: string, value?: string): Promise<void>;
    ids(): Promise<Ids>;
    /** New session and process group, led by this process. EPERM for a group leader. */
    setsid(): Promise<Pid>;
  };
  timers: {
    setInterval(callback: () => void, ms: number): Promise<number>;
    clearInterval(id: number): Promise<void>;
  };
  events: {
    subscribe<T extends EventType>(
      types: readonly T[],
      handler: EventHandler<T>,
    ): Promise<() => void>;
  };
  shell: {
    /** Open an https: or mailto: link outside the OS (kernel-mediated). */
    openExternal(url: string): Promise<void>;
    /** Read-only copy of the page URL. Untrusted: the link's author chose it. */
    location(): Promise<LocationInfo>;
    /** Save a file the caller can read to the user's real Downloads. */
    download(path: string): Promise<void>;
  };
  api: {
    fetch(path: string, request?: ApiRequest): Promise<ApiResponse>;
  };
  net: {
    fetch(url: string, request?: NetRequest): Promise<NetResponse>;
  };
  dialog: {
    open(options: DialogOptions): Promise<string | null>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
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
    /** Move within one mount; EXDEV across mounts (copy instead). */
    rename(from: string, to: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
  };
  io: {
    open(path: string, flags: OpenFlags): Promise<number>;
    close(fd: number): Promise<void>;
    read(fd: number, length: number): Promise<Bytes>;
    write(fd: number, data: Bytes): Promise<number>;
    seek(fd: number, offset: number, whence?: Whence): Promise<number>;
    dup(fd: number, to?: number): Promise<number>;
    fstat(fd: number): Promise<Stat>;
    listFds(): Promise<FdInfo[]>;
    pipe(): Promise<PipeFds>;
    openpty(): Promise<{ master: number; slave: number }>;
    /** Terminal control, on either end of a pty. ENOTTY on anything else. */
    tcgetattr(fd: number): Promise<Termios>;
    tcsetattr(fd: number, changes: Partial<Termios>): Promise<void>;
    /** The group ^C, ^Z and resizes go to; null until someone sets it. */
    tcgetpgrp(fd: number): Promise<Pid | null>;
    tcsetpgrp(fd: number, pgid: Pid): Promise<void>;
    getWinsize(fd: number): Promise<Winsize>;
    /** Sends SIGWINCH to the foreground group when the size changes. */
    setWinsize(fd: number, size: Winsize): Promise<void>;
  };
}

export interface SystemInterface extends AppInterface {
  display: AppInterface["display"] & {
    root(): Promise<HTMLElement>;
    taskbar(): Promise<HTMLElement>;
    reserveStrut(edge: StrutEdge, size: number): Promise<number>;
    releaseStrut(resourceId: number): Promise<void>;
    listStatusItems(): Promise<StatusItemInfo[]>;
    activateStatusItem(id: number, menuId: string): Promise<void>;
  };
  windows: Omit<AppInterface["windows"], "create"> & {
    create(options: WindowOptions): Promise<ElementWindowHandle>;
  };
}

export function bindSyscalls(target: SyscallTable, pid: Pid): SystemInterface {
  return {
    display: {
      root: () => target.getDisplayRoot(pid),
      taskbar: () => target.getTaskbarRoot(pid),
      workArea: () => target.getWorkArea(pid),
      reserveStrut: (edge, size) => target.reserveStrut(pid, edge, size),
      releaseStrut: (resourceId) => target.releaseStrut(pid, resourceId),
      addStatusItem: (spec, onSelect) =>
        target.addStatusItem(pid, spec, onSelect),
      updateStatusItem: (id, patch) => target.updateStatusItem(pid, id, patch),
      removeStatusItem: (id) => target.removeStatusItem(pid, id),
      listStatusItems: () => target.listStatusItems(pid),
      activateStatusItem: (id, menuId) =>
        target.activateStatusItem(pid, id, menuId),
    },
    windows: {
      create: (options) => target.createWindow(pid, options),
      list: () => target.listWindows(pid),
      focus: (windowId) => target.focusWindow(pid, windowId),
      setMinimized: (windowId, minimized) =>
        target.setMinimized(pid, windowId, minimized),
      setTitle: (windowId, title) =>
        target.setWindowTitle(pid, windowId, title),
      close: (windowId) => target.closeWindow(pid, windowId),
      onCloseRequest: (windowId, callback) =>
        target.onWindowCloseRequest(pid, windowId, callback),
    },
    process: {
      get signal() {
        return target.getSignal(pid);
      },
      get pid() {
        return pid;
      },
      spawn: (path, args, options) => target.spawn(pid, path, args, options),
      wait: (childPid, options) => target.wait(pid, childPid, options),
      exit: (code?) => target.exit(pid, code ?? 0),
      list: () => target.list(pid),
      onSignal: (signal, handler) => target.onSignal(pid, signal, handler),
      kill: (targetPid, signal) => target.kill(pid, targetPid, signal),
      history: () => target.history(pid),
      chdir: (path: string) => target.chdir(pid, path),
      cwd: () => target.cwd(pid),
      env: () => target.getenv(pid),
      setenv: (name, value) => target.setenv(pid, name, value),
      ids: () => target.ids(pid),
      setsid: () => target.setsid(pid),
    },
    timers: {
      setInterval: (callback, ms) => target.setInterval(pid, callback, ms),
      clearInterval: (id: number) => target.clearInterval(pid, id),
    },
    events: {
      subscribe: (types, handler) => target.subscribe(pid, types, handler),
    },
    shell: {
      openExternal: (url) => target.openExternal(pid, url),
      location: () => target.getLocation(pid),
      download: (path) => target.download(pid, path),
    },
    api: {
      fetch: (path, request) => target.apiFetch(pid, path, request),
    },
    net: {
      fetch: (url, request) => target.netFetch(pid, url, request),
    },
    dialog: {
      open: (options) => target.openDialog(pid, options),
    },
    clipboard: {
      writeText: (text) => target.clipboardWrite(pid, text),
      readText: () => target.clipboardRead(pid),
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
      rename: (from, to) => target.rename(pid, from, to),
      rmdir: (path) => target.rmdir(pid, path),
      chmod: (path, mode) => target.chmod(pid, path, mode),
      chown: (path, uid, gid) => target.chown(pid, path, uid, gid),
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
      tcgetattr: (fd) => target.tcgetattr(pid, fd),
      tcsetattr: (fd, changes) => target.tcsetattr(pid, fd, changes),
      tcgetpgrp: (fd) => target.tcgetpgrp(pid, fd),
      tcsetpgrp: (fd, pgid) => target.tcsetpgrp(pid, fd, pgid),
      getWinsize: (fd) => target.getWinsize(pid, fd),
      setWinsize: (fd, size) => target.setWinsize(pid, fd, size),
    },
  };
}

export function bindWindowHandle(
  pid: Pid,
  target: WindowHandleCommands,
  windowId: WindowId,
  body: HTMLElement,
): ElementWindowHandle {
  return {
    id: windowId,
    body: body,
    setTitle: (title: string) => target.setWindowTitle(pid, windowId, title),
    close: () => target.closeWindow(pid, windowId),
    onCloseRequest: (callback: () => void) =>
      target.onWindowCloseRequest(pid, windowId, callback),
  };
}
