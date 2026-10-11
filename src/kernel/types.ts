import type { DisplayInterface } from "./display/display";
import type { EventBusInterface } from "./events/bus";
import type { VFS } from "./fs/vfs";
import type { FdTable } from "./proc/fdTable";
import type { ProcessManagerInterface } from "./proc/manager";
import type { Signal } from "./proc/signals";
import type { FaultInfo } from "./proc/types";
import type { SystemInterface } from "./syscalls/api";
import type { WindowManagerInterface } from "./windows/managerInterface";
import type { PortServer } from "./wire/server";

export interface KernelContext {
  processes: ProcessManagerInterface;
  windows: WindowManagerInterface;
  display: DisplayInterface;
  events: EventBusInterface;
  fs: VFS;
  createOs(pid: Pid): SystemInterface;
  serve(port: MessagePort, pid: Pid): PortServer;
}

export type Pid = number & { readonly __brand: "pid" };
export type WindowId = number & { readonly __brand: "windowId" };

export type ExitRecord = {
  pid: Pid;
  parentPid: Pid;
  path: string;
  startedAt: number;
  termination: Termination;
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type StrutEdge = "top" | "right" | "bottom" | "left";

export type ProcessSignal = {
  readonly reason?: Signal | ExitReason;
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type ExitReason = "exit" | "signal" | "crash";

export interface Termination {
  code: number; // 0 for clean exit, non-zero for errors
  reason: ExitReason;
  signal?: Signal; // e.g., "SIGTERM", "SIGKILL", etc.
  at: number; // timestamp of termination
}

export interface Stopped {
  code: number; // 128 + signal number, like a shell's $?
  reason: "stopped";
  signal: Signal;
  at: number;
}

export type WaitStatus = Termination | Stopped;

export interface WaitOptions {
  untraced?: boolean;
}

export const ProcessStatus = {
  Loading: "loading",
  Running: "running",
  Stopped: "stopped",
  Exiting: "exiting",
  Zombie: "zombie",
} as const;

export type ProcessStatus = (typeof ProcessStatus)[keyof typeof ProcessStatus];

export type ResourceEntry = {
  id: number;
  kind: string; // e.g., "file", "socket", "pipe", etc.
  dispose(): void; // method to clean up the resource
};

export interface Process {
  pid: Pid;
  parentPid: Pid;
  privileged: boolean;
  /** Runs code from the VFS (a user-* realm), or descends from one: no api.fetch. */
  untrusted: boolean;
  path: string;
  args: string[];
  status: ProcessStatus;
  startedAt: number;
  termination: Termination;
  resources: Map<number, ResourceEntry>;
  files: FdTable;
  nextResourceId: number;
  waiters: Array<(termination: Termination) => void>;
  pgid: Pid;
  sid: Pid;
  stopped?: Signal;
  pendingStop?: Stopped;
  stopWaiters: Array<(stopped: Stopped) => void>;
  continueWaiters: Array<() => void>;
  abortController: AbortController;
  signalHandlers: Map<Signal, () => void>;
  faults: number;
  lastFault?: FaultInfo;
  /** Tail of what it wrote to fds 1/2: /proc/<pid>/log. */
  log: string;
  cwd: string;
  env: Record<string, string>;
  uid: number;
  euid: number;
  gid: number;
  surface?: { windowId: WindowId; claimed: boolean };
}

/** Read-only snapshot of the page URL (shell.location). Plain data: wire-safe. */
export interface LocationInfo {
  href: string;
  pathname: string;
  search: string;
  hash: string;
}

export interface ProcessInfo {
  pid: Pid;
  parentPid: Pid;
  path: string;
  status: ProcessStatus;
  startedAt: number;
  termination?: Termination;
  faults: number;
  cwd: string;
  uid: number;
  euid: number;
  pgid: Pid;
  sid: Pid;
  lastFault?: FaultInfo;
  readonly args: string[];
}

export interface ProcessInit {
  parentPid: Pid;
  path: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  privileged: boolean;
  untrusted?: boolean;
  uid: number;
  euid: number;
  gid: number;
  pgid?: Pid;
  sid?: Pid;
}

export type AppModule = {
  main(os: SystemInterface, args: string[]): void | Promise<void>;
};

export type Bytes = Uint8Array<ArrayBuffer>;
