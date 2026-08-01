import type { WindowHandle, WindowOptions } from "./windows/types";

export interface KernelInterface {
  display: { root(): HTMLElement };
  windows: { create(options: WindowOptions): WindowHandle };
  process: {
    readonly signal: ProcessSignal;
    readonly pid: number;
    onSignal(signal: Signal, handler: () => void): void;
    wait(pid: number): Promise<Termination>;
    spawn(path: string, args?: string[]): number;
    exit(code?: number): void;
    list(): ProcessInfo[];
    kill(pid: number, signal: Signal, code?: number): void;
    history(): readonly ExitRecord[];
  };
  timers: {
    setInterval(callback: () => void, ms: number): number;
    clearInterval(id: number): void;
  };
}

export type ExitRecord = {
  pid: number;
  parentPid: number;
  path: string;
  startedAt: number;
  termination: Termination;
};

export type ProcessSignal = {
  readonly reason?: Signal;
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

export const Signal = {
  SIGTERM: "SIGTERM",
  SIGKILL: "SIGKILL",
  SIGHUP: "SIGHUP",
  SIGINT: "SIGINT",
  SIGCHLD: "SIGCHLD",
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

export interface Process {
  pid: number;
  parentPid: number;
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
  pid: number;
  parentPid: number;
  path: string;
  status: ProcessStatus;
  startedAt: number;
  termination?: Termination;
}

export interface ProcessInit {
  parentPid: number;
  path: string;
  args: string[];
  privileged: boolean;
}

export type AppModule = {
  main(os: KernelInterface, args: string[]): void | Promise<void>;
};

export type Executable = () => Promise<AppModule>;
