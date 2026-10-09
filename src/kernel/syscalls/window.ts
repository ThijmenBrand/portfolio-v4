import { einval, enosys } from "../errors";
import type { KernelContext, Pid, WindowId } from "../types";
import { closeSurface } from "../windows/windowPolicy";
import type { WindowOptions } from "../windows/types";
import { bindWindowHandle } from "./api";
import { alive, requireAlive } from "./guards";
import type { SyscallTable } from "./table";

export type WindowHandleCommands = Pick<
  SyscallTable,
  "setWindowTitle" | "closeWindow" | "onWindowCloseRequest"
>;

export function windowSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  | "createWindow"
  | "claimWindow"
  | "listWindows"
  | "focusWindow"
  | "setMinimized"
> &
  WindowHandleCommands {
  const slice: Pick<
    SyscallTable,
    | "createWindow"
    | "claimWindow"
    | "listWindows"
    | "focusWindow"
    | "setMinimized"
  > &
    WindowHandleCommands = {
    createWindow: alive(ctx, (pid: Pid, windowOptions: WindowOptions) => {
      const windowRecord = ctx.windows.createWindow(windowOptions, pid);
      return bindWindowHandle(pid, slice, windowRecord.id, windowRecord.bodyEl);
    }),
    /**
     * An out-of-realm app can't receive a body element, so it can't create a
     * window the in-page way. An iframe process gets its window at exec (the
     * iframe has to live in it from the start: moving an iframe reloads it);
     * `windows.create` claims that one. v1: one window per iframe process.
     */
    claimWindow: alive(ctx, (pid: Pid, options: WindowOptions) => {
      const proc = requireAlive(ctx, pid);
      if (!proc.surface) throw enosys("windows.create (no window surface)");
      if (proc.surface.claimed) {
        throw einval("windows.create: the window was already claimed");
      }
      proc.surface.claimed = true;
      if (options?.title) {
        ctx.windows.setTitle(proc.surface.windowId, String(options.title));
      }
      return proc.surface.windowId;
    }),
    listWindows: async (pid: Pid) => {
      const proc = requireAlive(ctx, pid);
      const windows = ctx.windows.listWindows();
      if (proc.privileged) {
        return windows;
      }

      return windows.filter((w) => w.pid === pid);
    },
    focusWindow: async (pid: Pid, windowId: WindowId) => {
      const proc = requireAlive(ctx, pid);
      if (proc.privileged) {
        ctx.windows.focusWindow(windowId);
        return;
      }

      ctx.windows.validateWindowOwnership(windowId, pid);
      ctx.windows.focusWindow(windowId);
    },
    setMinimized: async (pid: Pid, windowId: WindowId, minimized: boolean) => {
      const proc = requireAlive(ctx, pid);
      if (proc.privileged) {
        ctx.windows.setMinimized(windowId, minimized);
        return;
      }

      ctx.windows.validateWindowOwnership(windowId, pid);
      ctx.windows.setMinimized(windowId, minimized);
    },
    setWindowTitle: alive(
      ctx,
      (pid: Pid, windowId: WindowId, title: string) => {
        ctx.windows.validateWindowOwnership(windowId, pid);
        ctx.windows.setTitle(windowId, title);
      },
    ),
    closeWindow: alive(ctx, (pid: Pid, windowId: WindowId) => {
      ctx.windows.validateWindowOwnership(windowId, pid);
      // Closing your own surface window is exiting: the realm lives in it.
      if (closeSurface(ctx, windowId, pid)) return;
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
