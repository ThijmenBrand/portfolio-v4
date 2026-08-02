import type { KernelContext } from "../context";
import { logError, enoexec } from "../errors";
import type { AppModule, Process } from "../types";
import { terminateProcess } from "./terminate";

export type Executable = () => Promise<AppModule>;

export function isExecutable(mod: unknown): mod is AppModule {
  return (
    typeof mod === "object" &&
    mod !== null &&
    typeof (mod as AppModule).main === "function"
  );
}

export async function execute(
  ctx: KernelContext,
  proc: Process,
  executable: Executable,
): Promise<void> {
  try {
    const module = await executable();
    if (proc.status !== "loading") return;
    if (!isExecutable(module)) {
      console.error(enoexec(proc.path));
      terminateProcess(ctx, proc.pid, 1, "crash");
      return;
    }
    ctx.processes.setStatus(proc.pid, "running");
    await module.main(ctx.createOs(proc.pid), proc.args);
  } catch (error) {
    logError(`Error executing process ${proc.pid}: ${error}`);
    terminateProcess(ctx, proc.pid, 1, "crash");
  }
}
