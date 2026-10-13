import { releaseStrut, reserveStrut } from "./struts";
import {
  activateStatusItem,
  addStatusItem,
  listStatusItems,
  removeStatusItem,
  updateStatusItem,
} from "./status";
import type { KernelContext, Pid, StrutEdge } from "../types";
import { alive, requirePrivilege } from "./guards";
import type { SyscallTable } from "./table";

export function displaySyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  | "getDisplayRoot"
  | "getTaskbarRoot"
  | "getWorkArea"
  | "reserveStrut"
  | "releaseStrut"
  | "addStatusItem"
  | "updateStatusItem"
  | "removeStatusItem"
  | "listStatusItems"
  | "activateStatusItem"
> {
  return {
    getDisplayRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getDisplayRoot");
      return ctx.display.getDesktopLayer();
    }),
    getTaskbarRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getTaskbarRoot");
      const layer = ctx.display.getTaskbarLayer();
      // A killed taskbar can't clean up after itself (logout SIGKILLs it).
      ctx.processes.registerResource(pid, "taskbar", () => layer.replaceChildren());
      return layer;
    }),
    getWorkArea: alive(ctx, (_pid: Pid) => ctx.display.workArea()),
    reserveStrut: alive(ctx, (pid: Pid, edge: StrutEdge, size: number) => {
      requirePrivilege(ctx, pid, "reserveStrut");
      return reserveStrut(ctx, pid, edge, size);
    }),
    releaseStrut: alive(ctx, (pid: Pid, resourceId: number) =>
      releaseStrut(ctx, pid, resourceId),
    ),
    addStatusItem: alive(
      ctx,
      (pid: Pid, spec: unknown, onSelect: (id: string) => void) =>
        addStatusItem(ctx, pid, spec, onSelect),
    ),
    updateStatusItem: alive(ctx, (pid: Pid, id: number, patch: unknown) =>
      updateStatusItem(ctx, pid, id, patch),
    ),
    removeStatusItem: alive(ctx, (pid: Pid, id: number) =>
      removeStatusItem(ctx, pid, id),
    ),
    listStatusItems: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "listStatusItems");
      return listStatusItems(ctx);
    }),
    activateStatusItem: alive(ctx, (pid: Pid, id: number, menuId: string) => {
      requirePrivilege(ctx, pid, "activateStatusItem");
      activateStatusItem(ctx, id, menuId);
    }),
  };
}
