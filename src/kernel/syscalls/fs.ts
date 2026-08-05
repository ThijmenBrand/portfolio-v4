import type { KernelContext } from "../context";
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
      requireAlive(ctx, callerPid);
      return await ctx.fs.stat(path);
    },
    readDir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.readdir(path);
    },
    readFile: async (callerPid, path) => {
      const proc = requireAlive(ctx, callerPid);
      return await ctx.fs.readFile(path, proc.abortController.signal);
    },
    writeFile: async (callerPid, path, data) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.writeFile(path, data);
    },
    mkdir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.mkdir(path);
    },
    rmdir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.rmdir(path);
    },
    unlink: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.unlink(path);
    },
  };
}
