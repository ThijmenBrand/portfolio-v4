import type { KernelContext } from "../context";
import type { Pid } from "../types";
import { alive, requirePrivilege } from "./guards";
import type { SyscallTable } from "./table";

export function displaySyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "getDisplayRoot" | "getTaskbarRoot"> {
  return {
    getDisplayRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getDisplayRoot");
      return ctx.display.getDesktopLayer();
    }),
    getTaskbarRoot: alive(ctx, (pid: Pid) => {
      requirePrivilege(ctx, pid, "getTaskbarRoot");
      return ctx.display.getTaskbarLayer();
    }),
  };
}
