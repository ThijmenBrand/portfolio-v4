import { alive } from "./guards";
import type { SyscallTable } from "./table";
import {
  setInterval,
  clearInterval,
  clearTimeout,
  setTimeout,
} from "../proc/timers";
import type { KernelContext } from "../context";
import type { Pid } from "../types";

export function timersSyscalls(
  ctx: KernelContext,
): Pick<
  SyscallTable,
  "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout"
> {
  return {
    setInterval: alive(ctx, (pid: Pid, callback: () => void, ms: number) =>
      setInterval(ctx, pid, callback, ms),
    ),
    clearInterval: alive(ctx, (pid: Pid, resourceId: number) =>
      clearInterval(ctx, pid, resourceId),
    ),
    setTimeout: alive(ctx, (pid: Pid, callback: () => void, ms: number) =>
      setTimeout(ctx, pid, callback, ms),
    ),
    clearTimeout: alive(ctx, (pid: Pid, resourceId: number) =>
      clearTimeout(ctx, pid, resourceId),
    ),
  };
}
