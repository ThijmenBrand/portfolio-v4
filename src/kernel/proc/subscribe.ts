import type { KernelContext } from "../context";
import { requireAlive } from "../syscalls/guards";
import type { Pid } from "../types";
import type { EventHandler, EventType } from "../events/types";
import { faultProcess } from "./faultproc";

export function subscribeEvents<T extends EventType>(
  ctx: KernelContext,
  pid: Pid,
  types: readonly T[],
  handler: EventHandler<T>,
): () => void {
  const { privileged } = requireAlive(ctx, pid);

  const unsubscribe = ctx.events.on(types, (event) => {
    const subject = "pid" in event ? event.pid : undefined;
    if (!privileged && subject !== undefined && subject !== pid) return;

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
