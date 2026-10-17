import { einval, enosys, eperm, kernelError } from "../errors";
import type { KernelContext, Pid, Process, WindowId } from "../types";
import { closeSurface } from "../windows/windowPolicy";
import { isTileZone, type SnapTarget } from "../windows/snap";
import type { WindowOptions, WindowPolicy } from "../windows/types";
import { bindWindowHandle } from "./api";
import { alive, requireAlive, requirePrivilege } from "./guards";
import type { SyscallTable } from "./table";

/**
 * Arranging and listing go as far as kill does: your own windows, those of
 * any process running as you, and everything for root and system processes.
 * (`wm` in a terminal owns no windows, but runs as the user whose apps it arranges.)
 */
function mayArrange(ctx: KernelContext, caller: Process, ownerPid: Pid): boolean {
  if (caller.pid === ownerPid || caller.privileged || caller.euid === 0) return true;
  const owner = ctx.processes.get(ownerPid);
  return owner !== undefined && (owner.uid === caller.uid || owner.uid === caller.euid);
}

const SNAP_TARGETS = new Set<unknown>(["maximize", "restore"]);

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
  | "tileWindow"
  | "setWindowPolicy"
  | "setWindowSize"
  | "setWindowVisible"
> &
  WindowHandleCommands {
  const slice: Pick<
    SyscallTable,
    | "createWindow"
    | "claimWindow"
    | "listWindows"
    | "focusWindow"
    | "setMinimized"
    | "tileWindow"
    | "setWindowPolicy"
    | "setWindowSize"
    | "setWindowVisible"
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
      // The window was sized at exec, from binfmt; a generic host (jsapp)
      // only learns the program's size here.
      const { width, height } = options ?? {};
      if (Number.isFinite(width) && Number.isFinite(height)) {
        ctx.windows.resizeTo(proc.surface.windowId, width!, height!);
      }
      if (options && ("translucent" in options || "titleBar" in options)) {
        ctx.windows.setAppearance(proc.surface.windowId, {
          title: "",
          translucent: options.translucent === true,
          titleBar: options.titleBar === "hidden" ? "hidden" : "default",
        });
      }
      return proc.surface.windowId;
    }),
    listWindows: async (pid: Pid) => {
      const proc = requireAlive(ctx, pid);
      return ctx.windows
        .listWindows()
        .filter((w) => mayArrange(ctx, proc, w.pid));
    },
    tileWindow: alive(
      ctx,
      (pid: Pid, windowId: WindowId, target: SnapTarget | "restore") => {
        if (!isTileZone(target) && !SNAP_TARGETS.has(target)) {
          throw einval(`windows.tile: unknown target ${String(target)}`);
        }
        const proc = requireAlive(ctx, pid);
        const info = ctx.windows.listWindows().find((w) => w.windowId === windowId);
        if (!info) throw kernelError("ENODEV", `Window with ID ${windowId} not found`);
        if (!mayArrange(ctx, proc, info.pid)) throw eperm(pid, "windows.tile");
        ctx.windows.arrange(windowId, target);
      },
    ),
    setWindowPolicy: alive(ctx, (pid: Pid, policy: WindowPolicy) => {
      requirePrivilege(ctx, pid, "windows.setPolicy");
      ctx.windows.setPolicy({ snap: policy?.snap !== false });
    }),
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
    setWindowSize: alive(
      ctx,
      (pid: Pid, windowId: WindowId, size: { width?: unknown; height?: unknown }) => {
        ctx.windows.validateWindowOwnership(windowId, pid);
        const current = ctx.windows.frameOf(windowId);
        const pick = (value: unknown, fallback: number) =>
          typeof value === "number" && Number.isFinite(value) ? value : fallback;
        ctx.windows.resizeTo(
          windowId,
          pick(size?.width, current.width),
          pick(size?.height, current.height),
        );
      },
    ),
    setWindowVisible: alive(ctx, (pid: Pid, windowId: WindowId, visible: boolean) => {
      ctx.windows.validateWindowOwnership(windowId, pid);
      ctx.windows.setVisible(windowId, visible === true);
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
