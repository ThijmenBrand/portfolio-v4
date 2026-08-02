import type { KernelContext } from "../context";
import { requireAlive } from "../syscalls/guards";
import type { Pid } from "../types";
import type { EventHandler, EventType } from "../events/types";

export function subscribeEvents<T extends EventType>(
  ctx: KernelContext,
  pid: Pid,
  types: readonly T[],
  handler: EventHandler<T>,
): () => void {
  const { privileged } = requireAlive(ctx, pid);

  const unsubscribe = ctx.events.on(types, (event) => {
    if (!privileged && event.pid !== pid) return;
    handler(event);
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
