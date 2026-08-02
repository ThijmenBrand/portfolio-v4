import type { KernelContext } from "../context";
import { isKernelError } from "../errors";
import type { Pid } from "../types";
import { terminateProcess } from "./terminate";
import type { FaultSite } from "./types";

const ABORT_EXIT_CODE = 134;

export function faultProcess(
  ctx: KernelContext,
  pid: Pid,
  error: unknown,
  site: FaultSite,
): void {
  const proc = ctx.processes.get(pid);
  if (!proc) return;

  const code = isKernelError(error) ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);

  ctx.processes.addFault(pid, { site, code, message, at: Date.now() });

  const label = code ? `${code}: ${message}` : message;
  const where = site === "main" ? "main — panicking" : site;
  console.error(
    `Process ${pid} (${proc.path}) faulted in ${where} — ${label}`,
    error,
  );

  if (site === "main") {
    terminateProcess(ctx, pid, ABORT_EXIT_CODE, "crash");
  }
}
