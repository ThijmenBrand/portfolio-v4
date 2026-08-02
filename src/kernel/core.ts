import type { KernelContext } from "./context";
import { Display } from "./display";
import { EventBus } from "./events/bus";
import { ProcessManager } from "./proc/manager";
import { bindSyscalls } from "./syscalls/api";
import { createSyscallTable } from "./syscalls/table";
import type { KernelInterface, Pid, WindowId } from "./types";
import { defaultClose, forceClose } from "./windowPolicy";
import { WindowManager } from "./windows/manager";

export function createKernel(screen: HTMLElement): {
  os: KernelInterface;
  boot(): void;
} {
  const display = new Display(screen);
  const processes = new ProcessManager();
  const events = new EventBus();

  const windows = new WindowManager(
    display.getWindowLayer(),
    {
      defaultClose: (windowId: WindowId, ownerPid: Pid) =>
        defaultClose(ctx, windowId, ownerPid),
      forceClose: (windowId: WindowId, ownerPid: Pid) =>
        forceClose(ctx, windowId, ownerPid),
    },
    { emit: (event) => events.emit(event) },
  );

  const ctx: KernelContext = {
    processes,
    display,
    windows,
    events,
    createOs: (pid) => bindSyscalls(table, pid),
  };

  const table = createSyscallTable(ctx);

  processes.allocate({
    parentPid: 0 as Pid,
    path: "/kernel",
    args: [],
    privileged: true,
  });
  processes.setStatus(0 as Pid, "running");

  const os = bindSyscalls(table, 0 as Pid);
  events.on(
    ["process.spawned", "process.exited", "window.created", "window.destroyed"],
    (e) => console.log(e),
  );
  return { os, boot: () => os.process.spawn("/System/desktop") };
}
