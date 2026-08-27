import type { KernelContext } from "../context";
import { eperm, esrch } from "../errors";
import type { Pid, Process } from "../types";

/**
 * Resolves the process from the process registry.
 * If no process could be found,
 * Or the proces has status exiting or zombie it throws
 * @param ctx KernelContext
 * @param pid Pid
 * @returns Process
 * @throws esrch
 */
export function requireAlive(ctx: KernelContext, pid: Pid): Process {
  const proc = ctx.processes.get(pid);

  if (!proc) throw esrch(pid);
  if (proc.status === "exiting" || proc.status === "zombie") {
    throw esrch(pid);
  }

  return proc;
}

export function requirePrivilege(
  ctx: KernelContext,
  pid: Pid,
  syscall: string,
): void {
  const proc = ctx.processes.get(pid);
  if (!proc) throw esrch(pid);
  if (!proc.privileged) throw eperm(pid, syscall);
}

export function rejectOnThrow<T = unknown>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

export function alive<T = unknown>(
  ctx: KernelContext,
  fn: (pid: Pid, ...args: any[]) => T,
) {
  return (pid: Pid, ...args: any[]) => {
    requireAlive(ctx, pid);
    return fn(pid, ...args);
  };
}

export function privileged(
  ctx: KernelContext,
  fn: (pid: Pid, ...args: any[]) => any,
) {
  return (pid: Pid, ...args: any[]) => {
    requirePrivilege(ctx, pid, "privileged guard");
    return fn(pid, ...args);
  };
}

export function requireControl(
  ctx: KernelContext,
  callerPid: Pid,
  targetPid: Pid,
): Process {
  const caller = ctx.processes.get(callerPid);
  const target = ctx.processes.get(targetPid);

  if (!caller || !target) throw esrch(targetPid);
  if (target.parentPid !== callerPid && !caller.privileged)
    throw eperm(callerPid, "requireControl");

  return target;
}
