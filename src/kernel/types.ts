import type { WindowHandle, WindowOptions } from "./windows/types";

export interface KernelInterface {
  display: { root(): HTMLElement };
  windows: { create(options: WindowOptions): WindowHandle };
  process: {
    readonly pid: number;
    spawn(path: string, args?: string[]): number;
    exit(code?: number): void;
  };
}

export const ProcessStatus = {
  Loading: "loading",
  Running: "running",
  Exited: "exited",
  Stopped: "stopped",
  Failed: "failed",
} as const;

export type ProcessStatus = (typeof ProcessStatus)[keyof typeof ProcessStatus];

export interface Process {
  pid: number;
  parentPid: number;
  privileged: boolean;
  path: string;
  args: string[];
  status: ProcessStatus;
  exitCode?: number;
  windowIds: number[];
  startedAt: number;
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
