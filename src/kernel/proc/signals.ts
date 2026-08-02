import type { KernelContext } from "../context";
import { einval, esrch } from "../errors";
import type { Pid } from "../types";
import { faultProcess } from "./faultproc";
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
    throw esrch(pid);
  }

  const handler = proc.signalHandlers.get(signal);
  if (!handler) return false;

  queueMicrotask(() => {
    try {
      handler();
    } catch (error) {
      faultProcess(ctx, proc.pid, error as Error, "signal");
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
      throw einval(signal);
  }
}
