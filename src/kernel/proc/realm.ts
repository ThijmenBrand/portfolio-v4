import type { KernelContext, Process } from "../types";
import { PROTOCOL_VERSION, type BootMessage } from "../wire/protocol";
import { faultProcess } from "./faultproc";

export async function executeWorker(
  ctx: KernelContext,
  proc: Process,
  entry: string,
) {
  const channel = new MessageChannel();
  const worker = new Worker(
    new URL("../../runtime/worker-entry.ts", import.meta.url),
    {
      type: "module",
      name: `${proc.path} [${proc.pid}]`,
    },
  );

  const server = ctx.serve(channel.port1, proc.pid);

  ctx.processes.registerResource(proc.pid, "realm", () => {
    server.close();
    worker.terminate();
  });

  const signal = ctx.processes.getSignal(proc.pid);
  signal.addEventListener("abort", () =>
    server.notifyAbort(String(signal.reason ?? "exit")),
  );

  worker.onerror = (e) => {
    e.preventDefault();
    faultProcess(
      ctx,
      proc.pid,
      new Error(e.message || "worker failed to load"),
      "main",
    );
  };

  ctx.processes.setStatus(proc.pid, "running");

  const boot = {
    t: "boot",
    v: PROTOCOL_VERSION,
    pid: proc.pid,
    path: proc.path,
    entry,
    args: proc.args,
  } satisfies BootMessage;
  worker.postMessage(boot, [channel.port2]);
}
