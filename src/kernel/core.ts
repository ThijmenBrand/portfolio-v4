import { Display, type DisplayInterface } from "./display";
import { isExecutable, resolve } from "./fs";
import { ProcessManager, type ProcessManagerInterface } from "./processes";
import {
  createSyscalls,
  createWindowHandle,
  type SyscallTarget,
} from "./syscalls";
import type { Executable, KernelInterface, Process } from "./types";
import type { WindowHandle, WindowOptions } from "./windows/types";
import { WindowManager } from "./windows/manager";
import type { WindowManagerInterface } from "./windows/managerInterface";

export class KernelCore implements SyscallTarget {
  public readonly os: KernelInterface;

  private readonly display: DisplayInterface;
  private readonly processManager: ProcessManagerInterface;
  private readonly windowManager: WindowManagerInterface;

  constructor(screen: HTMLElement) {
    this.display = new Display(screen);
    this.processManager = new ProcessManager();
    this.windowManager = new WindowManager(this.display.getWindowLayer());

    this.processManager.allocate({
      parentPid: 0,
      path: "/kernel",
      args: [],
      privileged: true,
    });
    this.os = createSyscalls(this, 0);
  }

  public boot(): void {
    console.log("Booting kernel...");
    this.os.process.spawn("/System/desktop");
  }

  public spawn(path: string, args: string[] = [], parentPid: number): number {
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
    this.processManager.setExitCode(pid, code);
    this.processManager.setStatus(pid, "exited");
  }

  public createWindow(options: WindowOptions, ownerPid: number): WindowHandle {
    const proc = this.processManager.get(ownerPid);
    if (!proc) {
      throw new Error(`ESRCH: No such process, ${ownerPid}`);
    }

    const windowRecord = this.windowManager.createWindow(options, ownerPid);
    proc.windowIds.push(windowRecord.id);

    return createWindowHandle(
      this,
      ownerPid,
      windowRecord.id,
      windowRecord.bodyEl,
    );
  }

  public setWindowTitle(windowId: number, pid: number, title: string): void {
    this.windowManager.validateWindowOwnership(windowId, pid);
    this.windowManager.setTitle(windowId, title);
  }

  public closeWindow(windowId: number, pid: number): void {
    this.windowManager.validateWindowOwnership(windowId, pid);
    const proc = this.processManager.get(pid);
    if (proc) {
      proc.windowIds = proc.windowIds.filter((id) => id !== windowId);
    }
    this.windowManager.destroy(windowId);
  }

  public onWindowCloseRequest(
    windowId: number,
    pid: number,
    callback: () => void,
  ): void {
    this.windowManager.validateWindowOwnership(windowId, pid);
    this.windowManager.addCloseRequestHandler(windowId, callback);
  }

  public getDisplayRoot(pid: number): HTMLElement {
    this.requirePrivilege(pid, this.getDisplayRoot.name);
    return this.display.getDesktopLayer();
  }

  private requirePrivilege(pid: number, syscall: string): Process {
    const proc = this.processManager.get(pid);
    if (!proc) throw new Error(`ESRCH: No such process, ${pid}`);
    if (!proc.privileged)
      throw new Error(`EPERM: Operation not permitted for ${pid}, ${syscall}`);

    return proc;
  }

  private syscallsFor(pid: number): KernelInterface {
    return createSyscalls(this, pid);
  }

  private async execute(proc: Process, executable: Executable): Promise<void> {
    try {
      const module = await executable();
      if (proc.status !== "loading") return;
      if (!isExecutable(module)) {
        console.error(`ENOEXEC: ${proc.path},`);
        this.processManager.setStatus(proc.pid, "failed");
        return;
      }
      this.processManager.setStatus(proc.pid, "running");
      await module.main(this.syscallsFor(proc.pid), proc.args);
    } catch (error) {
      this.processManager.setStatus(proc.pid, "failed");
      console.error(`Process ${proc.pid} failed to execute:`, error);
    }
  }
}
