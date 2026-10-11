import { einval, enoexec, eperm } from "../errors";
import { resolveFrom } from "../fs/path";
import { X } from "../fs/perm";
import { resolve } from "../binfmt";
import { execute } from "../proc/exec";
import { sendSignal } from "../proc/signals";
import { terminateProcess } from "../proc/terminate";
import { waitFor } from "../proc/wait";
import type { KernelContext, Pid, Process } from "../types";
import { alive, requireAlive, requireControl } from "./guards";
import type { SyscallTable } from "./table";
import { changeDirectory, getCwd } from "../proc/cwd";
import { FdTable } from "../proc/fdTable";

export interface SpawnOptions {
  fds?: Record<number, number>; // child fd -> parent fd
  env?: Record<string, string>;
  /** Run the child as this user (uid = euid = `uid`). Root only, like setuid(2). */
  uid?: number;
  gid?: number;
}

/** A process's ids, as `id` prints them. */
export interface Ids {
  uid: number;
  euid: number;
  gid: number;
}

const decoder = new TextDecoder();

/**
 * Not in binfmt: maybe a script in the VFS. `#!interpreter [arg]` runs as
 * `interpreter [arg] script ...args`, like Linux's binfmt_script.
 * ponytail: the interpreter must be in binfmt (no script-runs-script), which
 * also rules out loops. No exec bit: any readable file with #! runs.
 */
async function startScript(
  ctx: KernelContext,
  path: string,
  args: string[],
  options: SpawnOptions,
  parentPid: Pid,
): Promise<Pid> {
  const parent = requireAlive(ctx, parentPid);
  const script = resolveFrom(parent.cwd, path);
  // ENOENT/EISDIR/EACCES as-is
  const data = await ctx.fs.readFile(script, undefined, parent);
  const firstLine = decoder.decode(data.slice(0, 256)).split("\n")[0]!;
  if (!firstLine.startsWith("#!")) throw enoexec(path);

  const [interpreter, arg] = firstLine.slice(2).trim().split(/\s+/, 2);
  if (!interpreter || !resolve(interpreter)) throw enoexec(path);

  const argv = [...(arg ? [arg] : []), script, ...args];
  return startProcess(ctx, interpreter, argv, options, parentPid);
}

async function startProcess(
  ctx: KernelContext,
  path: string,
  args: string[],
  options: SpawnOptions,
  parentPid: Pid,
): Promise<Pid> {
  const file = resolve(path);
  if (!file) {
    return startScript(ctx, path, args, options, parentPid);
  }

  const parent = requireAlive(ctx, parentPid);
  // Program files carry their mode too (core.ts mountPrograms).
  await ctx.fs.access(path, parent, X);
  const ids = childIds(parent, options, file.setuid === true);

  const inherited = options?.fds
    ? FdTable.resolveMapping(parent.files, options.fds)
    : undefined;

  const process = ctx.processes.allocate({
    parentPid,
    args,
    path,
    privileged: file.privileged === true,
    cwd: parent?.cwd ?? "/",
    env: { ...parent.env, ...options?.env },
    ...ids,
  });

  if (inherited) process.files.adopt(inherited);
  else process.files.inheritFrom(parent.files);

  void execute(ctx, process, file);
  ctx.events.emit({
    type: "process.spawned",
    pid: process.pid,
    parentPid: process.parentPid,
    path: process.path,
    at: Date.now(),
  });

  return process.pid;
}

/**
 * Inherited from the parent, unless root asks for another user, or the
 * program is setuid (it runs as root, but keeps the caller as its real uid so
 * su/passwd know who called them).
 */
function childIds(parent: Process, options: SpawnOptions, setuid: boolean): Ids {
  if (options?.uid !== undefined) {
    if (parent.euid !== 0) throw eperm(parent.pid, "spawn as another user");
    const gid = options.gid ?? options.uid;
    return { uid: options.uid, euid: options.uid, gid };
  }
  if (setuid) return { uid: parent.uid, euid: 0, gid: parent.gid };
  return { uid: parent.uid, euid: parent.euid, gid: parent.gid };
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
  | "getenv"
  | "setenv"
  | "ids"
> {
  return {
    spawn: alive(ctx, (parentPid, path, args, options) =>
      startProcess(ctx, path, args, options, parentPid),
    ),
    exit: (pid, code) => terminateProcess(ctx, pid, code, "exit"),
    kill: alive(ctx, async (callerPid, targetPid, signal) => {
      requireControl(ctx, callerPid, targetPid);
      await sendSignal(ctx, targetPid, signal);
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
    cwd: async (callerPid) => getCwd(ctx, callerPid),
    ids: async (callerPid) => {
      const { uid, euid, gid } = requireAlive(ctx, callerPid);
      return { uid, euid, gid };
    },
    getenv: async (callerPid) => ({ ...requireAlive(ctx, callerPid).env }),
    setenv: async (callerPid, name, value) => {
      if (name === "" || name.includes("=")) throw einval(name);
      const { env } = requireAlive(ctx, callerPid);
      if (value === undefined) delete env[name];
      else env[name] = value;
    },
  };
}
