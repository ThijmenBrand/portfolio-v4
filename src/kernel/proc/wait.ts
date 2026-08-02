import type { KernelContext } from "../context";
import {
  rejectOnThrow,
  requireAlive,
  requireControl,
} from "../syscalls/guards";
import type { Pid, Termination } from "../types";

export function waitFor(
  ctx: KernelContext,
  callerPid: Pid,
  targetPid: Pid,
): Promise<Termination> {
  return rejectOnThrow(() => {
    requireAlive(ctx, callerPid);

    if (callerPid === targetPid) {
      throw new Error(`EINVAL: Process ${callerPid} cannot wait for itself`);
    }

    const target = requireControl(ctx, callerPid, targetPid);

    if (target.status === "zombie") {
      const termination = { ...target.termination };
      ctx.processes.reap(targetPid);
      return Promise.resolve(termination);
    }

    return new Promise<Termination>((resolve, reject) => {
      let resourceId = -1;

      const removeWaiter = ctx.processes.addWaiter(targetPid, (termination) => {
        resolve({ ...termination });
        ctx.processes.reap(targetPid);
        ctx.processes.unregisterResource(callerPid, resourceId);
      });

      resourceId = ctx.processes.registerResource(callerPid, "wait", () => {
        removeWaiter();
        reject(
          new Error(`EINTR: Wait for process ${targetPid} was interrupted`),
        );
      });
    });
  });
}
