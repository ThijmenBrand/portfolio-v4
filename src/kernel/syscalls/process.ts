import { einval, enoexec, eperm, esrch } from "../errors";
import { resolveFrom } from "../fs/path";
import { X } from "../fs/perm";
import { resolve } from "../binfmt";
import { execute } from "../proc/exec";
import { sendSignal, type Signal } from "../proc/signals";
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
  uid?: number;
  gid?: number;
  pgid?: number;
}

export interface Ids {
  uid: number;
  euid: number;
  gid: number;
  pgid: Pid;
  sid: Pid;
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
  return startProcess(ctx, interpreter, argv, options, parentPid, script);
}

/**
 * `shownAs`: a script's process goes by the script's path (ps, the taskbar,
 * pins), not its interpreter's; argv still starts with the script.
 */
async function startProcess(
  ctx: KernelContext,
  path: string,
  args: string[],
  options: SpawnOptions,
  parentPid: Pid,
  shownAs = path,
): Promise<Pid> {
  const file = resolve(path);
  if (!file) {
    return startScript(ctx, path, args, options, parentPid);
  }

  const parent = requireAlive(ctx, parentPid);
  // Program files carry their mode too (core.ts mountPrograms).
  await ctx.fs.access(path, parent, X);
  const ids = childIds(parent, options, file.setuid === true);
  const pgid = childGroup(ctx, parent, options?.pgid);

  const inherited = options?.fds
    ? FdTable.resolveMapping(parent.files, options.fds)
    : undefined;

  const process = ctx.processes.allocate({
    parentPid,
    args,
    path: shownAs,
    privileged: file.privileged === true,
    cwd: parent?.cwd ?? "/",
    env: { ...parent.env, ...options?.env },
    ...ids,
    pgid,
    sid: parentPid === 0 ? undefined : parent.sid,
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
/** undefined: a new group led by the child. */
function childGroup(
  ctx: KernelContext,
  parent: Process,
  pgid: number | undefined,
): Pid | undefined {
  if (pgid === undefined) return parent.pid === 0 ? undefined : parent.pgid;
  if (pgid === 0) return undefined;
  const sameSession = ctx.processes
    .inGroup(pgid as Pid)
    .some((member) => member.sid === parent.sid);
  if (!sameSession)
    throw eperm(parent.pid, "spawn into another session's group");
  return pgid as Pid;
}

function childIds(
  parent: Process,
  options: SpawnOptions,
  setuid: boolean,
): Pick<Ids, "uid" | "euid" | "gid"> {
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
  | "setsid"
> {
  const signalOne = async (callerPid: Pid, targetPid: Pid, signal: Signal) => {
    const caller = requireAlive(ctx, callerPid);
    const target = ctx.processes.get(targetPid);
    const sameUser =
      target !== undefined &&
      (caller.uid === target.uid || caller.euid === target.uid);
    if (!sameUser) requireControl(ctx, callerPid, targetPid);
    await sendSignal(ctx, targetPid, signal);
  };

  return {
    spawn: alive(ctx, (parentPid, path, args, options) =>
      startProcess(ctx, path, args, options, parentPid),
    ),
    exit: (pid, code) => terminateProcess(ctx, pid, code, "exit"),
    kill: alive(ctx, async (callerPid, targetPid, signal) => {
      if (targetPid >= 0) return signalOne(callerPid, targetPid, signal);
      const members = ctx.processes.inGroup(-targetPid as Pid);
      if (members.length === 0) throw esrch(targetPid);
      let denied: unknown;
      let sent = 0;
      for (const member of members) {
        try {
          await signalOne(callerPid, member.pid, signal);
          sent += 1;
        } catch (error) {
          denied = error;
        }
      }
      if (sent === 0) throw denied;
    }),
    wait: (callerPid, targetPid, options) =>
      waitFor(ctx, callerPid, targetPid, options),
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
      const { uid, euid, gid, pgid, sid } = requireAlive(ctx, callerPid);
      return { uid, euid, gid, pgid, sid };
    },
    // A new session and group, led by the caller. A group leader can't:
    // its group would be split across two sessions.
    setsid: alive(ctx, (callerPid) => {
      const proc = requireAlive(ctx, callerPid);
      if (proc.pgid === proc.pid) throw eperm(callerPid, "setsid");
      proc.pgid = proc.sid = proc.pid;
      return proc.pid;
    }),
    getenv: async (callerPid) => ({ ...requireAlive(ctx, callerPid).env }),
    setenv: async (callerPid, name, value) => {
      if (name === "" || name.includes("=")) throw einval(name);
      const { env } = requireAlive(ctx, callerPid);
      if (value === undefined) delete env[name];
      else env[name] = value;
    },
  };
}
