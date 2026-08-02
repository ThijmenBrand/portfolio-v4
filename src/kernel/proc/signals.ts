import type { KernelContext } from "../context";
import type { Pid } from "../types";
import { terminateProcess } from "./terminate";

export const Signal = {
  SIGTERM: "SIGTERM",
  SIGKILL: "SIGKILL",
  SIGHUP: "SIGHUP",
  SIGINT: "SIGINT",
  SIGCHLD: "SIGCHLD",
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

export function deliver(ctx: KernelContext, pid: Pid, signal: Signal): boolean {
  const proc = ctx.processes.get(pid);
  if (!proc) {
    throw new Error(`ESRCH: No such process, ${pid}`);
  }

  const handler = proc.signalHandlers.get(signal);
  if (!handler) return false;

  queueMicrotask(() => {
    try {
      handler();
    } catch (error) {
      console.error(
        `Error in signal handler for process ${proc.pid} (${signal}):`,
        error,
      );
    }
  });

  return true;
}

export function sendSignal(ctx: KernelContext, pid: Pid, signal: Signal): void {
  switch (signal) {
    case Signal.SIGKILL:
      return terminateProcess(ctx, pid, 137, "signal", signal);
    case Signal.SIGTERM:
    case Signal.SIGHUP:
    case Signal.SIGINT:
      if (!deliver(ctx, pid, signal))
        terminateProcess(ctx, pid, 143, "signal", signal);
      return;
    case Signal.SIGCHLD:
      deliver(ctx, pid, signal); // Default action: ignore
      return;
    default:
      const exaustive: never = signal;
      throw new Error(`EINVAL: Unknown signal: ${exaustive}`);
  }
}
