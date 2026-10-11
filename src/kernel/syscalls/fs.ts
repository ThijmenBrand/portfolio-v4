import { resolveFrom } from "../fs/path";
import { changeDirectory, getCwd } from "../proc/cwd";
import type { KernelContext } from "../types";
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
  | "chmod"
  | "chown"
> {
  return {
    stat: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.stat(resolveFrom(proc.cwd, path), proc);
    },
    readDir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readdir(resolveFrom(proc.cwd, path), proc);
    },
    readFile: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readFile(
        resolveFrom(proc.cwd, path),
        proc.abortController.signal,
        proc,
      );
    },
    writeFile: async (callerPid, path, data) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.writeFile(
        resolveFrom(proc.cwd, path),
        data,
        proc.abortController.signal,
        proc,
      );
    },
    mkdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.mkdir(resolveFrom(proc.cwd, path), proc);
    },
    rmdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.rmdir(resolveFrom(proc.cwd, path), proc);
    },
    unlink: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.unlink(resolveFrom(proc.cwd, path), proc);
    },
    chmod: async (callerPid, path, mode) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.chmod(resolveFrom(proc.cwd, path), mode, proc);
    },
    chown: async (callerPid, path, uid, gid) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.chown(resolveFrom(proc.cwd, path), uid, gid, proc);
    },
    chdir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await changeDirectory(ctx, callerPid, path);
    },
    cwd: async (callerPid) => {
      requireAlive(ctx, callerPid);
      return getCwd(ctx, callerPid);
    },
  };
}
