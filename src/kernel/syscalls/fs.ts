import type { KernelContext } from "../context";
import { at } from "../fs/path";
import { requireAlive } from "./guards";
import type { SyscallTable } from "./table";

export function fsSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  "stat" | "readDir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rmdir"
> {
  return {
    stat: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.stat(at(proc, path));
    },
    readDir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readdir(at(proc, path));
    },
    readFile: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readFile(at(proc, path), proc.abortController.signal);
    },
    writeFile: async (callerPid, path, data) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.writeFile(
        at(proc, path),
        data,
        proc.abortController.signal,
      );
    },
    mkdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.mkdir(at(proc, path));
    },
    rmdir: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.rmdir(at(proc, path));
    },
    unlink: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.unlink(at(proc, path));
    },
  };
}
