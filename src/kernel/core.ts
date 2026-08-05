import type { KernelContext } from "./context";
import { Display } from "./display/display";
import { EventBus } from "./events/bus";
import { MemFS } from "./fs/drivers/memfs";
import { ProcFS } from "./fs/drivers/procfs";
import { VFS } from "./fs/vfs";
import { faultProcess } from "./proc/faultproc";
import { ProcessManager } from "./proc/manager";
import { bindSyscalls, type KernelInterface } from "./syscalls/api";
import { createSyscallTable } from "./syscalls/table";
import type { Pid } from "./types";
import { defaultClose, forceClose } from "./windowPolicy";
import { WindowManager } from "./windows/manager";

export function createKernel(screen: HTMLElement): {
  os: KernelInterface;
  boot(): Promise<void>;
} {
  const display = new Display(screen);
  const processes = new ProcessManager();
  const events = new EventBus();
  const fs = new VFS();

  fs.mount({
    path: "/",
    driver: new MemFS(),
    readonly: false,
  });
  fs.mount({
    path: "/proc",
    driver: new ProcFS({
      list: () => processes.list(),
    }),
    readonly: true,
  });

  const windows = new WindowManager(
    display.getWindowLayer(),
    {
      defaultClose: (windowId, ownerPid) =>
        defaultClose(ctx, windowId, ownerPid),
      forceClose: (windowId, ownerPid) => forceClose(ctx, windowId, ownerPid),
      fault: (pid, error, site) => faultProcess(ctx, pid, error, site),
    },
    { emit: (event) => events.emit(event) },
    { get: () => display.workArea() },
  );

  display.onWorkAreaChange(() => {
    windows.reflowMaximized();
    events.emit({ type: "display.workAreaChanged", area: display.workArea() });
  });

  const ctx: KernelContext = {
    processes,
    display,
    windows,
    events,
    fs,
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
  return {
    os,
    boot: async () => {
      await fs.mkdir("/home");
      await fs.mkdir("/tmp");
      os.process.spawn("/System/desktop");
    },
  };
}
