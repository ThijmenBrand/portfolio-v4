import type { EventHandler, EventType } from "../events/types";
import { subscribeEvents } from "../proc/subscribe";
import type { KernelContext, Pid } from "../types";
import type { SyscallTable } from "./table";

export function eventsSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "subscribe"> {
  return {
    subscribe: async <T extends EventType>(
      callerPid: Pid,
      types: readonly T[],
      handler: EventHandler<T>,
    ) => {
      return subscribeEvents(ctx, callerPid, types, handler);
    },
  };
}
