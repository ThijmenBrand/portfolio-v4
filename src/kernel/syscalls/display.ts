import type { KernelContext } from "../context";
import { releaseStrut, reserveStrut } from "../struts";
import type { Pid, StrutEdge } from "../types";
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
> {
  return {
    getDisplayRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getDisplayRoot");
      return ctx.display.getDesktopLayer();
    }),
    getTaskbarRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getTaskbarRoot");
      return ctx.display.getTaskbarLayer();
    }),
    getWorkArea: alive(ctx, (_pid: Pid) => ctx.display.workArea()),
    reserveStrut: alive(ctx, (pid: Pid, edge: StrutEdge, size: number) => {
      requirePrivilege(ctx, pid, "reserveStrut");
      return reserveStrut(ctx, pid, edge, size);
    }),
    releaseStrut: alive(ctx, (pid: Pid, resourceId: number) =>
      releaseStrut(ctx, pid, resourceId),
    ),
  };
}
