import type { KernelContext } from "../context";
import { normalize } from "../fs/path";
import { requireAlive } from "../syscalls/guards";
import type { Pid } from "../types";

export function changeDirectory(
  ctx: KernelContext,
  pid: Pid,
  path: string,
): void {
  const proc = requireAlive(ctx, pid);
  const normalized = normalize(path);

  ctx.processes.setCwd(proc.pid, normalized);
}

export function getCwd(ctx: KernelContext, pid: Pid): string {
  const proc = requireAlive(ctx, pid);
  return ctx.processes.getCwd(proc.pid);
}
