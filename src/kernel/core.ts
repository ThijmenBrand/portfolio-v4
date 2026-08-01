import { Display, type DisplayInterface } from "./display";
import { isExecutable, resolve } from "./fs";
import { ProcessManager, type ProcessManagerInterface } from "./processes";
import {
  createSyscalls,
  createWindowHandle,
  type SyscallTarget,
} from "./syscalls";
import type {
  Executable,
  ExitReason,
  Process,
  Signal,
  KernelInterface,
  ProcessSignal,
  Termination,
  ProcessInfo,
  ExitRecord,
} from "./types";
import type { WindowHandle, WindowOptions } from "./windows/types";
import { WindowManager } from "./windows/manager";
import type { WindowManagerInterface } from "./windows/managerInterface";

export class KernelCore implements SyscallTarget {
  public readonly os: KernelInterface;

  private readonly display: DisplayInterface;
  private readonly processManager: ProcessManagerInterface;
  private readonly windowManager: WindowManagerInterface;

  private static readonly SIGTERM_TIMEOUT_MS = 5000;

  constructor(screen: HTMLElement) {
    this.display = new Display(screen);
    this.processManager = new ProcessManager();
    this.windowManager = new WindowManager(this.display.getWindowLayer(), {
      defaultClose: (windowId: number, ownerPid: number) =>
        this.defaultClose(windowId, ownerPid),
      forceClose: (windowId: number, ownerPid: number) =>
        this.forceClose(windowId, ownerPid),
    });

    this.processManager.allocate({
      parentPid: 0,
      path: "/kernel",
      args: [],
      privileged: true,
    });
    this.os = createSyscalls(this, 0);
    this.processManager.setStatus(0, "running");
  }

  public boot(): void {
    console.log("Booting kernel...");
    this.os.process.spawn("/System/desktop");
  }

  public spawn(path: string, args: string[] = [], parentPid: number): number {
    this.requireAlive(parentPid);

    const file = resolve(path);
    if (!file) {
      throw new Error(`ENOENT: No such file or directory, ${path}`);
    }

    const process = this.processManager.allocate({
      parentPid,
      args,
      path,
      privileged: file.privileged === true,
    });

    void this.execute(process, file.load);
    return process.pid;
  }

  public exit(pid: number, code: number): void {
    this.terminate(pid, code, "exit");
  }

  public ps(): ProcessInfo[] {
    return this.processManager.list().map((p) => ({
      pid: p.pid,
      parentPid: p.parentPid,
      path: p.path,
      status: p.status,
      startedAt: p.startedAt,
      termination: p.termination ? { ...p.termination } : undefined,
    }));
  }

  public createWindow(options: WindowOptions, ownerPid: number): WindowHandle {
    this.requireAlive(ownerPid);

    const proc = this.processManager.get(ownerPid);
    if (!proc) {
      throw new Error(`ESRCH: No such process, ${ownerPid}`);
    }

    const windowRecord = this.windowManager.createWindow(options, ownerPid);

    return createWindowHandle(
      this,
      ownerPid,
      windowRecord.id,
      windowRecord.bodyEl,
    );
  }

  public setWindowTitle(windowId: number, pid: number, title: string): void {
    this.requireAlive(pid);

    this.windowManager.validateWindowOwnership(windowId, pid);
    this.windowManager.setTitle(windowId, title);
  }

  public closeWindow(windowId: number, pid: number): void {
    this.requireAlive(pid);

    this.windowManager.validateWindowOwnership(windowId, pid);
    this.windowManager.destroy(windowId);
  }

  public onWindowCloseRequest(
    windowId: number,
    pid: number,
    callback: () => void,
  ): void {
    this.requireAlive(pid);

    this.windowManager.validateWindowOwnership(windowId, pid);
    this.windowManager.addCloseRequestHandler(windowId, callback);
  }

  public getDisplayRoot(pid: number): HTMLElement {
    this.requireAlive(pid);
    this.requirePrivilege(pid, this.getDisplayRoot.name);

    return this.display.getDesktopLayer();
  }

  public onSignal(pid: number, signal: Signal, handler: () => void): void {
    const proc = this.requireAlive(pid);
    if (signal === "SIGKILL") {
      throw new Error("EINVAL: SIGKILL cannot be caught");
    }

    proc.signalHandlers.set(signal, handler);
  }

  public wait(pid: number, callerPid: number): Promise<Termination> {
    const caller = this.processManager.get(callerPid);
    if (!caller || caller.status === "exiting" || caller.status === "zombie") {
      return Promise.reject(new Error(`ESRCH: No such process, ${callerPid}`));
    }

    const target = this.processManager.get(pid);
    if (!target) {
      return Promise.reject(new Error(`ESRCH: No such child process, ${pid}`));
    }
    if (target.parentPid !== callerPid && !caller.privileged) {
      return Promise.reject(
        new Error(
          `EPERM: Process ${callerPid} is not allowed to wait for ${pid}`,
        ),
      );
    }

    if (target.status === "zombie") {
      const termination = target.termination;
      this.processManager.reap(pid);
      return Promise.resolve(termination);
    }

    return new Promise<Termination>((resolve, reject) => {
      let resourceId = -1;
      const remove = this.processManager.addWaiter(pid, (termination) => {
        this.processManager.unregisterResource(callerPid, resourceId);
        resolve(termination);
        this.processManager.reap(pid);
      });
      resourceId = this.processManager.registerResource(
        callerPid,
        "wait",
        () => {
          remove();
          reject(
            new Error(
              `Process ${callerPid} terminated while waiting for ${pid}`,
            ),
          );
        },
      );
    });
  }

  public setInterval(pid: number, fn: () => void, ms: number): number {
    this.requireAlive(pid);
    const timer = window.setInterval(() => {
      try {
        fn();
      } catch (error) {
        console.error(`interval in process ${pid}:`, error);
      }
    }, ms);

    return this.processManager.registerResource(pid, "interval", () =>
      window.clearInterval(timer),
    );
  }

  public clearInterval(pid: number, resourceId: number): void {
    const proc = this.processManager.get(pid);
    proc?.resources.get(resourceId)?.dispose();
    this.processManager.unregisterResource(pid, resourceId);
  }

  public kill(pid: number, signal: Signal, senderPid: number): void {
    this.requireAlive(pid);
    // check if senderPid is parent of pid or senderPid is privileged
    const senderProc = this.processManager.get(senderPid);
    if (!senderProc) {
      throw new Error(`ESRCH: No such process, ${senderPid}`);
    }

    const targetProc = this.processManager.get(pid);
    if (!targetProc) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    if (senderProc.pid !== targetProc.parentPid && !senderProc.privileged) {
      throw new Error(
        `EPERM: Process ${senderPid} is not allowed to send signal to ${pid}`,
      );
    }

    switch (signal) {
      case "SIGKILL":
        this.terminate(pid, 137, "signal", signal);
        return;
      case "SIGTERM":
      case "SIGINT":
      case "SIGHUP":
        if (!this.deliver(targetProc, signal))
          this.terminate(pid, 143, "signal", signal);
        return;
      case "SIGCHLD":
        this.deliver(targetProc, signal);
        return;
      default: {
        const exhaustive: never = signal;
        throw new Error(`EINVAL: Unknown signal ${exhaustive}`);
      }
    }
  }

  public history(): readonly ExitRecord[] {
    return this.processManager.history();
  }

  private deliver(proc: Process, signal: Signal): boolean {
    const handler = proc.signalHandlers.get(signal);
    if (!handler) return false;

    queueMicrotask(() => {
      try {
        handler();
      } catch (error) {
        console.error(
          `Error in signal handler for process ${proc.pid} (${signal}):`,
          error,
        );
      }
    });

    return true;
  }

  private armWatchdog(pid: number, signal: Signal): void {
    const proc = this.processManager.get(pid);
    if (!proc) return;
    if (
      Array.from(proc.resources.values()).some((res) => res.kind === "watchdog")
    )
      return;

    const timer = setTimeout(() => {
      console.warn(`Process ${pid} ignored ${signal}, sending SIGKILL`);
      this.terminate(pid, 137, "signal", "SIGKILL");
    }, KernelCore.SIGTERM_TIMEOUT_MS);

    this.processManager.registerResource(pid, "watchdog", () =>
      clearTimeout(timer),
    );
  }

  private requirePrivilege(pid: number, syscall: string): Process {
    const proc = this.processManager.get(pid);
    if (!proc) throw new Error(`ESRCH: No such process, ${pid}`);
    if (!proc.privileged)
      throw new Error(`EPERM: Operation not permitted for ${pid}, ${syscall}`);

    return proc;
  }

  private terminate(
    pid: number,
    code: number,
    reason: ExitReason,
    signal?: Signal,
  ): void {
    const proc = this.processManager.get(pid);
    if (!proc) return;
    if (proc.status === "exiting" || proc.status === "zombie") return;
    if (pid === 0) {
      throw new Error("EPERM: Cannot terminate the kernel process");
    }

    this.processManager.setStatus(pid, "exiting");
    try {
      proc.abortController.abort();
    } catch (error) {
      console.error(`Error aborting process ${pid}:`, error);
    }

    const children = this.processManager.childrenOf(pid);
    for (const child of children) {
      if (child.status !== "zombie") continue;

      this.processManager.reap(child.pid);
    }
    this.processManager.reparentChildren(pid, 0);

    this.windowManager.releaseFor(pid);
    this.processManager.disposeResources(pid);
    proc.signalHandlers.clear();

    const termination = {
      code,
      reason,
      signal,
      at: Date.now(),
    };

    this.processManager.setTermination(pid, termination);
    this.processManager.setStatus(pid, "zombie");
    this.processManager.resolveWaiters(pid);

    const parent = this.processManager.get(proc.parentPid);
    if (parent) this.deliver(parent, "SIGCHLD");

    if (
      !parent ||
      parent.status === "zombie" ||
      parent.status === "exiting" ||
      proc.parentPid === 0
    ) {
      this.processManager.reap(pid);
    }

    console.log(
      `Process ${pid} terminated with code ${code}, reason: ${reason}${
        signal ? `, signal: ${signal}` : ""
      }`,
    );
  }

  private defaultClose(windowId: number, ownerPid: number): void {
    this.windowManager.destroy(windowId);
    if (this.windowManager.windowCountFor(ownerPid) === 0) {
      this.kill(ownerPid, "SIGTERM", 0);
    }
  }

  private forceClose(_windowId: number, ownerPid: number): void {
    this.kill(ownerPid, "SIGKILL", 0);
  }

  private requireAlive(pid: number): Process {
    const proc = this.processManager.get(pid);
    if (!proc) throw new Error(`ESRCH: No such process, ${pid}`);
    if (proc.status === "exiting" || proc.status === "zombie") {
      throw new Error(`ESRCH: Process ${pid} is not alive`);
    }

    return proc;
  }

  private syscallsFor(pid: number): KernelInterface {
    return createSyscalls(this, pid);
  }

  public getProcessSignal(pid: number): ProcessSignal {
    const proc = this.processManager.get(pid);
    if (!proc) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    return proc.abortController.signal;
  }

  private async execute(proc: Process, executable: Executable): Promise<void> {
    try {
      const module = await executable();
      if (proc.status !== "loading") return;
      if (!isExecutable(module)) {
        console.error(`NOEXEC: File ${proc.path} is not executable`);
        this.terminate(proc.pid, 1, "crash");
        return;
      }
      this.processManager.setStatus(proc.pid, "running");
      await module.main(this.syscallsFor(proc.pid), proc.args);
    } catch (error) {
      console.error(`Error executing process ${proc.pid}:`, error);
      this.terminate(proc.pid, 1, "crash");
    }
  }
}
