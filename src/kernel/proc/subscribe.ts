import { requireAlive } from "../syscalls/guards";
import type { KernelContext, Pid } from "../types";
import type { EventHandler, EventType, KernelEvent } from "../events/types";
import { dirname } from "../fs/path";
import { faultProcess } from "./faultproc";

export function subscribeEvents<T extends EventType>(
  ctx: KernelContext,
  pid: Pid,
  types: readonly T[],
  handler: EventHandler<T>,
): () => void {
  const proc = requireAlive(ctx, pid);

  const unsubscribe = ctx.events.on(types, (event) => {
    const subject = "pid" in event ? event.pid : undefined;
    if (!proc.privileged && subject !== undefined && subject !== pid) return;
    const known: KernelEvent = event;
    if (
      known.type === "fs.changed" &&
      !ctx.fs.mayList(dirname(known.path), proc)
    )
      return;

    try {
      handler(event);
    } catch (error) {
      faultProcess(ctx, pid, error, "event");
    }
  });

  const resourceId = ctx.processes.registerResource(
    pid,
    "subscription",
    unsubscribe,
  );

  return () => {
    unsubscribe();
    ctx.processes.unregisterResource(pid, resourceId);
  };
}
