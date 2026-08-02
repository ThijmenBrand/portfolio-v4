import type { KernelContext } from "./context";
import { sendSignal } from "./proc/signals";
import { terminateProcess } from "./proc/terminate";
import type { Pid, WindowId } from "./types";

export function defaultClose(
  ctx: KernelContext,
  windowId: WindowId,
  ownerPid: Pid,
): void {
  ctx.windows.destroy(windowId);

  if (ctx.windows.windowCountFor(ownerPid) === 0) {
    sendSignal(ctx, ownerPid, "SIGTERM");
  }
}

export function forceClose(
  ctx: KernelContext,
  _windowId: WindowId,
  ownerPid: Pid,
): void {
  terminateProcess(ctx, ownerPid, 137, "signal", "SIGKILL");
}
