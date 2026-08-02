import type { KernelContext } from "../context";
import type { EventHandler, EventType } from "../events/types";
import { subscribeEvents } from "../proc/subscribe";
import type { Pid } from "../types";
import type { SyscallTable } from "./table";

export function eventsSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "subscribe"> {
  return {
    subscribe: <T extends EventType>(
      callerPid: Pid,
      types: readonly T[],
      handler: EventHandler<T>,
    ) => {
      return subscribeEvents(ctx, callerPid, types, handler);
    },
  };
}
