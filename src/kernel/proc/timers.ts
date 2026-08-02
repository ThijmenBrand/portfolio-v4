import type { KernelContext } from "../context";
import type { Pid } from "../types";

export function setInterval(
  ctx: KernelContext,
  pid: Pid,
  callback: () => void,
  ms: number,
): number {
  const timer = window.setInterval(() => {
    try {
      callback();
    } catch (error) {
      console.error(`interval in process ${pid}:`, error);
    }
  }, ms);

  return ctx.processes.registerResource(pid, "interval", () =>
    window.clearInterval(timer),
  );
}

export function setTimeout(
  ctx: KernelContext,
  pid: Pid,
  callback: () => void,
  ms: number,
): number {
  const timer = window.setTimeout(() => {
    try {
      callback();
    } catch (error) {
      console.error(`timeout in process ${pid}:`, error);
    }
  }, ms);

  return ctx.processes.registerResource(pid, "timeout", () =>
    window.clearTimeout(timer),
  );
}

export function clearInterval(
  ctx: KernelContext,
  pid: Pid,
  resourceId: number,
): void {
  const proc = ctx.processes.get(pid);
  proc?.resources.get(resourceId)?.dispose();
  ctx.processes.unregisterResource(pid, resourceId);
}

export function clearTimeout(
  ctx: KernelContext,
  pid: Pid,
  resourceId: number,
): void {
  const proc = ctx.processes.get(pid);
  proc?.resources.get(resourceId)?.dispose();
  ctx.processes.unregisterResource(pid, resourceId);
}
