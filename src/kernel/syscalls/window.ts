import type { KernelContext } from "../context";
import type { Pid, WindowId } from "../types";
import type { WindowOptions } from "../windows/types";
import { bindWindowHandle } from "./api";
import { alive, requirePrivilege } from "./guards";
import type { SyscallTable } from "./table";

export type WindowHandleCommands = Pick<
  SyscallTable,
  "setWindowTitle" | "closeWindow" | "onWindowCloseRequest"
>;

export function windowSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  "createWindow" | "listWindows" | "focusWindow" | "setMinimized"
> &
  WindowHandleCommands {
  const slice: Pick<
    SyscallTable,
    "createWindow" | "listWindows" | "focusWindow" | "setMinimized"
  > &
    WindowHandleCommands = {
    createWindow: alive(ctx, (pid: Pid, windowOptions: WindowOptions) => {
      const windowRecord = ctx.windows.createWindow(windowOptions, pid);
      return bindWindowHandle(pid, slice, windowRecord.id, windowRecord.bodyEl);
    }),
    listWindows: alive(ctx, (pid: Pid) => {
      const windows = ctx.windows.listWindows();
      try {
        requirePrivilege(ctx, pid, "listWindows");
        return windows;
      } catch {
        return windows.filter((w) => w.pid === pid);
      }
    }),
    focusWindow: alive(ctx, (pid: Pid, windowId: WindowId) => {
      try {
        requirePrivilege(ctx, pid, "focusWindow");
        ctx.windows.focusWindow(windowId);
      } catch {
        ctx.windows.validateWindowOwnership(windowId, pid);
        ctx.windows.focusWindow(windowId);
      }
    }),
    setMinimized: alive(
      ctx,
      (pid: Pid, windowId: WindowId, minimized: boolean) => {
        try {
          requirePrivilege(ctx, pid, "setMinimized");
          ctx.windows.setMinimized(windowId, minimized);
        } catch {
          ctx.windows.validateWindowOwnership(windowId, pid);
          ctx.windows.setMinimized(windowId, minimized);
        }
      },
    ),
    setWindowTitle: alive(
      ctx,
      (pid: Pid, windowId: WindowId, title: string) => {
        ctx.windows.validateWindowOwnership(windowId, pid);
        ctx.windows.setTitle(windowId, title);
      },
    ),
    closeWindow: alive(ctx, (pid: Pid, windowId: WindowId) => {
      ctx.windows.validateWindowOwnership(windowId, pid);
      ctx.windows.destroy(windowId);
    }),
    onWindowCloseRequest: alive(
      ctx,
      (pid: Pid, windowId: WindowId, callback: () => void) => {
        ctx.windows.validateWindowOwnership(windowId, pid);
        ctx.windows.addCloseRequestHandler(windowId, callback);
      },
    ),
  };

  return slice;
}
