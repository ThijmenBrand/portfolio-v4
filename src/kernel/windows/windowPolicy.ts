import { logError } from "../errors";
import { sendSignal } from "../proc/signals";
import { terminateProcess } from "../proc/terminate";
import type { KernelContext, Pid, WindowId } from "../types";

export function defaultClose(
  ctx: KernelContext,
  windowId: WindowId,
  ownerPid: Pid,
): void {
  ctx.windows.destroy(windowId);

  if (ctx.windows.windowCountFor(ownerPid) === 0) {
    void sendSignal(ctx, ownerPid, "SIGTERM").catch(logError);
  }
}

export function forceClose(
  ctx: KernelContext,
  _windowId: WindowId,
  ownerPid: Pid,
): void {
  void terminateProcess(ctx, ownerPid, 137, "signal", "SIGKILL").catch(
    logError,
  );
}
