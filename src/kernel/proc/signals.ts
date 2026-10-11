import { einval, esrch, logError } from "../errors";
import type { KernelContext, Pid, Stopped } from "../types";
import { faultProcess } from "./faultproc";
import { terminateProcess } from "./terminate";

export const Signal = {
  SIGHUP: "SIGHUP",
  SIGINT: "SIGINT",
  SIGKILL: "SIGKILL",
  SIGTERM: "SIGTERM",
  SIGCHLD: "SIGCHLD",
  SIGCONT: "SIGCONT",
  SIGSTOP: "SIGSTOP",
  SIGTSTP: "SIGTSTP",
  SIGWINCH: "SIGWINCH",
} as const;

export type Signal = (typeof Signal)[keyof typeof Signal];

const NUMBER: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGWINCH: 28,
};

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

export async function sendSignal(
  ctx: KernelContext,
  pid: Pid,
  signal: Signal,
): Promise<void> {
  if (!Object.hasOwn(NUMBER, signal)) throw einval(signal);
  const code = 128 + NUMBER[signal];

  switch (signal) {
    case Signal.SIGKILL:
      return await terminateProcess(ctx, pid, code, "signal", signal);
    case Signal.SIGSTOP:
      return stop(ctx, pid, signal);
    case Signal.SIGTSTP:
      if (!deliver(ctx, pid, signal)) stop(ctx, pid, signal);
      return;
    case Signal.SIGCONT:
      resume(ctx, pid);
      deliver(ctx, pid, signal);
      return;
    case Signal.SIGCHLD:
    case Signal.SIGWINCH:
      deliver(ctx, pid, signal); // Default action: ignore
      return;
    default:
      if (!deliver(ctx, pid, signal))
        await terminateProcess(ctx, pid, code, "signal", signal);
  }
}

/**
 * Every process in group `pgid`, without permission checks: the caller
 * (the terminal's line discipline, or kill after its own checks) decided.
 */
export function signalGroup(
  ctx: KernelContext,
  pgid: Pid,
  signal: Signal,
): void {
  for (const proc of ctx.processes.inGroup(pgid)) {
    sendSignal(ctx, proc.pid, signal).catch(logError);
  }
}

/** Its syscalls park from here on (see gateStopped); its parent hears about it. */
function stop(ctx: KernelContext, pid: Pid, signal: Signal): void {
  const proc = ctx.processes.get(pid);
  if (!proc) throw esrch(pid);
  if (pid === 0 || proc.stopped) return;
  if (proc.status === "exiting" || proc.status === "zombie") return;

  proc.stopped = signal;
  const stopped: Stopped = {
    code: 128 + NUMBER[signal],
    reason: "stopped",
    signal,
    at: Date.now(),
  };
  const waiters = proc.stopWaiters.splice(0);
  proc.pendingStop = waiters.length === 0 ? stopped : undefined;
  for (const waiter of waiters) waiter(stopped);

  if (ctx.processes.get(proc.parentPid))
    deliver(ctx, proc.parentPid, "SIGCHLD");
}

function resume(ctx: KernelContext, pid: Pid): void {
  const proc = ctx.processes.get(pid);
  if (!proc) throw esrch(pid);
  if (!proc.stopped) return;

  proc.stopped = undefined;
  proc.pendingStop = undefined;
  for (const wake of proc.continueWaiters.splice(0)) wake();
}
