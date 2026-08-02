import type { EventHandler, EventType } from "./events/types";
import type { Signal } from "./proc/signals";
import type { WindowHandle, WindowOptions } from "./windows/types";

export interface KernelInterface {
  display: { root(): HTMLElement };
  windows: { create(options: WindowOptions): WindowHandle };
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

export type Pid = number & { readonly __brand: "pid" };
export type WindowId = number & { readonly __brand: "windowId" };

export type ExitRecord = {
  pid: Pid;
  parentPid: Pid;
  path: string;
  startedAt: number;
  termination: Termination;
};

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

export const ProcessStatus = {
  Loading: "loading",
  Running: "running",
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
  path: string;
  args: string[];
  status: ProcessStatus;
  startedAt: number;
  termination: Termination;
  resources: Map<number, ResourceEntry>;
  nextResourceId: number;
  waiters: Array<(termination: Termination) => void>;
  abortController: AbortController;
  signalHandlers: Map<Signal, () => void>;
}

export interface ProcessInfo {
  pid: Pid;
  parentPid: Pid;
  path: string;
  status: ProcessStatus;
  startedAt: number;
  termination?: Termination;
}

export interface ProcessInit {
  parentPid: Pid;
  path: string;
  args: string[];
  privileged: boolean;
}

export type AppModule = {
  main(os: KernelInterface, args: string[]): void | Promise<void>;
};
