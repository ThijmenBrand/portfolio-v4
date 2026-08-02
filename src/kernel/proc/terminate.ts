import type { KernelContext } from "../context";
import type { ExitReason, Pid } from "../types";
import { sendSignal, Signal } from "./signals";

export function terminateProcess(
  ctx: KernelContext,
  pid: Pid,
  code: number,
  reason: ExitReason,
  signal?: Signal,
) {
  const proc = ctx.processes.get(pid);
  if (!proc) return;
  if (proc.status === "exiting" || proc.status === "zombie") return;
  if (pid === 0) {
    throw new Error("EPERM: Cannot terminate the kernel process");
  }

  ctx.processes.setStatus(pid, "exiting");
  try {
    proc.abortController.abort(signal ?? reason);
  } catch (error) {
    console.error(`Error aborting process ${pid}:`, error);
  }

  const children = ctx.processes.childrenOf(pid);
  for (const child of children) {
    if (child.status !== "zombie") continue;

    ctx.processes.reap(child.pid);
  }
  ctx.processes.reparentChildren(pid, 0 as Pid);

  ctx.windows.releaseFor(pid);
  ctx.processes.disposeResources(pid);
  proc.signalHandlers.clear();

  const termination = {
    code,
    reason,
    signal,
    at: Date.now(),
  };

  ctx.processes.setTermination(pid, termination);
  ctx.processes.setStatus(pid, "zombie");
  ctx.processes.resolveWaiters(pid);

  const parent = ctx.processes.get(proc.parentPid);
  if (parent) sendSignal(ctx, parent.pid, "SIGCHLD");

  if (
    !parent ||
    parent.status === "zombie" ||
    parent.status === "exiting" ||
    proc.parentPid === 0
  ) {
    ctx.processes.reap(pid);
  }
}
