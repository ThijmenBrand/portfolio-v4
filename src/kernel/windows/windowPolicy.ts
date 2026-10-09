import { logError } from "../errors";
import { sendSignal } from "../proc/signals";
import { terminateProcess } from "../proc/terminate";
import type { KernelContext, Pid, WindowId } from "../types";

/**
 * An iframe process's realm lives INSIDE its surface window. Once that window
 * is gone there is nothing left to run, so the process must end — otherwise
 * it lingers as "running" with a dead realm (and a SIGTERM handler could
 * never run). Returns true if it handled the close.
 */
export function closeSurface(
  ctx: KernelContext,
  windowId: WindowId,
  ownerPid: Pid,
): boolean {
  if (ctx.processes.get(ownerPid)?.surface?.windowId !== windowId) return false;
  // terminate's teardown destroys the window (and with it the iframe).
  void terminateProcess(ctx, ownerPid, 0, "exit").catch(logError);
  return true;
}

export function defaultClose(
  ctx: KernelContext,
  windowId: WindowId,
  ownerPid: Pid,
): void {
  if (closeSurface(ctx, windowId, ownerPid)) return;
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
