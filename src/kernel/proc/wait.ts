import { eintr } from "../errors";
import {
  rejectOnThrow,
  requireAlive,
  requireControl,
} from "../syscalls/guards";
import type {
  KernelContext,
  Pid,
  Stopped,
  WaitOptions,
  WaitStatus,
} from "../types";

export function waitFor(
  ctx: KernelContext,
  callerPid: Pid,
  targetPid: Pid,
  options?: WaitOptions,
): Promise<WaitStatus> {
  return rejectOnThrow(() => {
    requireAlive(ctx, callerPid);

    if (callerPid === targetPid) {
      throw eintr(callerPid);
    }

    const target = requireControl(ctx, callerPid, targetPid);

    if (target.status === "zombie") {
      const termination = { ...target.termination };
      ctx.processes.reap(targetPid);
      return Promise.resolve(termination);
    }

    // A stop nobody has reported yet: report it now, once.
    if (options?.untraced && target.pendingStop) {
      const stopped = target.pendingStop;
      target.pendingStop = undefined;
      return Promise.resolve({ ...stopped });
    }

    return new Promise<WaitStatus>((resolve, reject) => {
      let resourceId = -1;

      const onStop = (stopped: Stopped) => {
        removeWaiter();
        ctx.processes.unregisterResource(callerPid, resourceId);
        resolve({ ...stopped });
      };
      const removeStopWaiter = () => {
        const index = target.stopWaiters.indexOf(onStop);
        if (index !== -1) target.stopWaiters.splice(index, 1);
      };
      if (options?.untraced) target.stopWaiters.push(onStop);

      const removeWaiter = ctx.processes.addWaiter(targetPid, (termination) => {
        removeStopWaiter();
        resolve({ ...termination });
        ctx.processes.reap(targetPid);
        ctx.processes.unregisterResource(callerPid, resourceId);
      });

      resourceId = ctx.processes.registerResource(callerPid, "wait", () => {
        removeWaiter();
        removeStopWaiter();
        reject(eintr(callerPid));
      });
    });
  });
}
