import type { KernelContext } from "./context";
import { Display } from "./display";
import { ProcessManager } from "./proc/manager";
import type { Signal } from "./proc/signals";
import { terminateProcess } from "./proc/terminate";
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

  const windows = new WindowManager(display.getWindowLayer(), {
    defaultClose: (windowId: WindowId, ownerPid: Pid) =>
      defaultClose(ctx, windowId, ownerPid),
    forceClose: (windowId: WindowId, ownerPid: Pid) =>
      forceClose(ctx, windowId, ownerPid),
  });

  const ctx: KernelContext = {
    processes,
    display,
    windows,
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
  return { os, boot: () => os.process.spawn("/System/desktop") };
}

const SIGTERM_TIMEOUT_MS = 5000;

function armWatchdog(ctx: KernelContext, pid: Pid, signal: Signal): void {
  const proc = ctx.processes.get(pid);
  if (!proc) return;
  if (
    Array.from(proc.resources.values()).some((res) => res.kind === "watchdog")
  )
    return;

  const timer = setTimeout(() => {
    console.warn(`Process ${pid} ignored ${signal}, sending SIGKILL`);
    terminateProcess(ctx, pid, 137, "signal", "SIGKILL");
  }, SIGTERM_TIMEOUT_MS);

  ctx.processes.registerResource(pid, "watchdog", () => clearTimeout(timer));
}
