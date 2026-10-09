import type { FileEntry } from "../binfmt";
import { enoexec } from "../errors";
import type { AppModule, KernelContext, Process } from "../types";
import { faultProcess } from "./faultproc";
import { executeWorker } from "./realm";
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
  file: FileEntry,
): Promise<void> {
  try {
    if (file.format === "worker") return executeWorker(ctx, proc, file.entry);

    const module = await file.load();

    if (proc.status !== "loading") return;
    if (!isExecutable(module)) {
      console.error(enoexec(proc.path));
      await terminateProcess(ctx, proc.pid, 1, "crash");
      return;
    }
    ctx.processes.setStatus(proc.pid, "running");
    await module.main(ctx.createOs(proc.pid), proc.args);
  } catch (error) {
    faultProcess(ctx, proc.pid, error as Error, "main");
  }
}
