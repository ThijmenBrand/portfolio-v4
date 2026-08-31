import type { KernelContext } from "../context";
import { einval, enoent } from "../errors";
import { resolve } from "../binfmt";
import { execute } from "../proc/exec";
import { sendSignal } from "../proc/signals";
import { terminateProcess } from "../proc/terminate";
import { waitFor } from "../proc/wait";
import type { Pid } from "../types";
import { alive, requireAlive, requireControl } from "./guards";
import type { SyscallTable } from "./table";
import { changeDirectory, getCwd } from "../proc/cwd";
import { FdTable } from "../proc/fdTable";

export interface SpawnOptions {
  fds?: Record<number, number>; // child fd -> parent fd
}

function startProcess(
  ctx: KernelContext,
  path: string,
  args: string[],
  options: SpawnOptions,
  parentPid: Pid,
): Pid {
  const file = resolve(path);
  if (!file) {
    throw enoent(path);
  }

  const parent = requireAlive(ctx, parentPid);

  const inherited = options?.fds
    ? FdTable.resolveMapping(parent.files, options.fds)
    : undefined;

  const process = ctx.processes.allocate({
    parentPid,
    args,
    path,
    privileged: file.privileged === true,
    cwd: parent?.cwd ?? "/",
  });

  if (inherited) process.files.adopt(inherited);
  else process.files.inheritFrom(parent.files);

  void execute(ctx, process, file.load);
  ctx.events.emit({
    type: "process.spawned",
    pid: process.pid,
    parentPid: process.parentPid,
    path: process.path,
    at: Date.now(),
  });

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
  | "chdir"
  | "cwd"
> {
  return {
    spawn: alive(ctx, (parentPid, path, args, options) =>
      startProcess(ctx, path, args, options, parentPid),
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
        throw einval(`Cannot register handler for SIGKILL`);
      }

      return ctx.processes.setSignalHandler(callerPid, signal, handler);
    },
    getSignal: (callerPid: Pid) => ctx.processes.getSignal(callerPid),
    list: alive(ctx, (_pid) => ctx.processes.list()),
    history: alive(ctx, (_pid) => ctx.processes.history()),
    chdir: (callerPid, path) => changeDirectory(ctx, callerPid, path),
    cwd: (callerPid) => getCwd(ctx, callerPid),
  };
}
