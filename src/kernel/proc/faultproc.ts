import type { KernelContext } from "../context";
import type { Pid } from "../types";
import { terminateProcess } from "./terminate";

type FaultSite =
  | "main"
  | "syscall"
  | "window"
  | "interval"
  | "timeout"
  | "signal";

export function faultProcess(
  ctx: KernelContext,
  pid: Pid,
  error: Error,
  site: FaultSite,
): void {
  ctx.processes.addFault(pid);

  if (site === "main") {
    console.error(`Process ${pid} faulted in main. Panicking:`, error);
    terminateProcess(ctx, pid, 1, "crash", "SIGABRT");
    return;
  }

  console.error(`Process ${pid} faulted in ${site}:`, error);
}
