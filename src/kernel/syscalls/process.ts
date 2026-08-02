import type { KernelContext } from "../context";
import { resolve } from "../fs";
import { execute } from "../proc/exec";
import { sendSignal } from "../proc/signals";
import { terminateProcess } from "../proc/terminate";
import { waitFor } from "../proc/wait";
import type { Pid } from "../types";
import { alive, requireAlive, requireControl } from "./guards";
import type { SyscallTable } from "./table";

function startProcess(
  ctx: KernelContext,
  path: string,
  args: string[],
  parentPid: Pid,
): Pid {
  const file = resolve(path);
  if (!file) {
    throw new Error(`ENOENT: No such file or directory, ${path}`);
  }

  const process = ctx.processes.allocate({
    parentPid,
    args,
    path,
    privileged: file.privileged === true,
  });

  void execute(ctx, process, file.load);
  return process.pid;
}

export function processSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  | "spawn"
  | "exit"
  | "kill"
  | "wait"
  | "list"
  | "getSignal"
  | "onSignal"
  | "history"
> {
  return {
    spawn: alive(ctx, (parentPid, path, args) =>
      startProcess(ctx, path, args, parentPid),
    ),
    exit: (pid, code) => terminateProcess(ctx, pid, code, "exit"),
    kill: alive(ctx, (callerPid, targetPid, signal) => {
      requireControl(ctx, callerPid, targetPid);
      sendSignal(ctx, targetPid, signal);
    }),
    wait: (callerPid, targetPid) => waitFor(ctx, callerPid, targetPid),
    onSignal: (callerPid, signal, handler) => {
      requireAlive(ctx, callerPid);
      if (signal === "SIGKILL") {
        throw new Error(`EINVAL: Cannot register handler for SIGKILL`);
      }

      return ctx.processes.setSignalHandler(callerPid, signal, handler);
    },
    getSignal: (callerPid: Pid) => ctx.processes.getSignal(callerPid),
    list: alive(ctx, (_pid) => ctx.processes.list()),
    history: alive(ctx, (_pid) => ctx.processes.history()),
  };
}
