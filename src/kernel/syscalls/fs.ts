import type { KernelContext } from "../context";
import { requireAlive } from "./guards";
import type { SyscallTable } from "./table";

export function fsSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  "stat" | "readDir" | "readFile" | "writeFile" | "mkdir" | "unlink"
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
      requireAlive(ctx, callerPid);
      return await ctx.fs.readFile(path);
    },
    writeFile: async (callerPid, path, data) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.writeFile(path, data);
    },
    mkdir: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.mkdir(path);
    },
    unlink: async (callerPid, path) => {
      requireAlive(ctx, callerPid);
      return await ctx.fs.unlink(path);
    },
  };
}
