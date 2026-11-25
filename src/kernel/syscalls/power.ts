import { einval, eperm } from "../errors";
import { ADMIN_GID } from "../fs/perm";
import { REBOOT_KINDS, type RebootKind } from "../power";
import { Signal, sendSignal } from "../proc/signals";
import type { KernelContext, Pid } from "../types";
import { alive, privileged, requireAlive } from "./guards";
import type { SyscallTable } from "./table";

const DESKTOP = "/System/desktop";

/**
 * Power. Anyone may restart: it ends the session they are in and nothing
 * else. Erasing needs root or the admin group, judged on the real ids, so
 * `sudo` by an admin works and `su root` works, but a guest cannot.
 */
export function powerSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "reboot" | "syncStorage" | "takeReboot" | "eraseStorage"> {
  return {
    reboot: alive(ctx, async (callerPid: Pid, kind: RebootKind) => {
      if (!REBOOT_KINDS.includes(kind)) throw einval(`reboot: unknown kind ${String(kind).slice(0, 40)}`);
      const caller = requireAlive(ctx, callerPid);
      if (kind === "reset" && caller.uid !== 0 && caller.gid !== ADMIN_GID) {
        throw eperm(callerPid, "reboot");
      }
      // Login runs one desktop at a time, and not necessarily as the caller
      // (after `su root` the real uid is 0 while the session is its user's).
      const desktop = ctx.processes
        .list()
        .find((proc) => proc.path === DESKTOP && proc.status === "running");
      if (!desktop) throw einval("reboot: no desktop session");
      // A reset already asked for is never downgraded by a later restart.
      if (ctx.power.pending !== "reset") ctx.power.pending = kind;
      // The kernel signals directly: this is a request to end the session,
      // not a kill the caller has to be allowed to make.
      await sendSignal(ctx, desktop.pid, Signal.SIGTERM);
    }),
    /** sync(2): every program may ask for what is in memory to be written out. */
    syncStorage: alive(ctx, () => ctx.power.sync()),
    /** Privileged: login collects the request once the session has ended. */
    takeReboot: privileged(ctx, () => {
      const kind = ctx.power.pending;
      ctx.power.pending = undefined;
      return kind;
    }),
    /** Privileged: login, after the sign-out and the last sync. */
    eraseStorage: privileged(ctx, () => ctx.power.erase()),
  };
}
