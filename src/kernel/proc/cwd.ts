import type { KernelContext } from "../context";
import { enotdir } from "../errors";
import { resolveFrom } from "../fs/path";
import { requireAlive } from "../syscalls/guards";
import type { Pid } from "../types";

export async function changeDirectory(
  ctx: KernelContext,
  pid: Pid,
  path: string,
): Promise<void> {
  const proc = requireAlive(ctx, pid);
  const normalized = resolveFrom(proc.cwd, path);

  const stat = await ctx.fs.stat(normalized);
  if (stat.kind !== "directory") throw enotdir(normalized);

  const alive = requireAlive(ctx, pid);
  ctx.processes.setCwd(alive.pid, normalized);
}

export function getCwd(ctx: KernelContext, pid: Pid): string {
  return requireAlive(ctx, pid).cwd;
}
