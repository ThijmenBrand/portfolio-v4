import type { KernelContext } from "../context";
import { resolveFrom } from "../fs/path";
import { changeDirectory, getCwd } from "../proc/cwd";
import { requireAlive } from "./guards";
import type { SyscallTable } from "./table";

export function fsSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  | "stat"
  | "readDir"
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "unlink"
  | "rmdir"
  | "chdir"
  | "cwd"
> {
  return {
    stat: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.stat(resolveFrom(proc.cwd, path));
    },
    readDir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readdir(resolveFrom(proc.cwd, path));
    },
    readFile: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readFile(
        resolveFrom(proc.cwd, path),
        proc.abortController.signal,
      );
    },
    writeFile: async (callerPid, path, data) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.writeFile(
        resolveFrom(proc.cwd, path),
        data,
        proc.abortController.signal,
      );
    },
    mkdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.mkdir(resolveFrom(proc.cwd, path));
    },
    rmdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.rmdir(resolveFrom(proc.cwd, path));
    },
    unlink: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.unlink(resolveFrom(proc.cwd, path));
    },
    chdir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await changeDirectory(ctx, callerPid, path);
    },
    cwd: (callerPid) => {
      requireAlive(ctx, callerPid);
      return getCwd(ctx, callerPid);
    },
  };
}
