import type { KernelContext } from "./context";
import type { Pid, StrutEdge } from "./types";

export function reserveStrut(
  ctx: KernelContext,
  pid: Pid,
  edge: StrutEdge,
  size: number,
): number {
  const strutId = ctx.display.addStrut(edge, size);

  return ctx.processes.registerResource(pid, "strut", () =>
    ctx.display.removeStrut(strutId),
  );
}

export function releaseStrut(
  ctx: KernelContext,
  pid: Pid,
  resourceId: number,
): void {
  const proc = ctx.processes.get(pid);
  proc?.resources.get(resourceId)?.dispose();
  ctx.processes.unregisterResource(pid, resourceId);
}
