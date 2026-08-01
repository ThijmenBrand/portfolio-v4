import type { Process, ProcessInit } from "./types";

export interface ProcessManagerInterface {
  allocate(init: ProcessInit): Process;
  get(pid: number): Process | undefined;
  list(): Process[];
  setStatus(pid: number, status: Process["status"]): void;
  setExitCode(pid: number, exitCode: number): void;
  remove(pid: number): void;
}

export class ProcessManager implements ProcessManagerInterface {
  nextProcessId: number;
  processes: Map<number, Process>;

  constructor() {
    this.nextProcessId = 0;
    this.processes = new Map();
  }

  public allocate(init: ProcessInit): Process {
    const pid = this.nextProcessId++;
    const process: Process = {
      pid,
      parentPid: init.parentPid,
      privileged: init.privileged,
      args: init.args,
      path: init.path,
      status: "loading",
      windowIds: [],
      startedAt: Date.now(),
    };

    this.processes.set(pid, process);
    return process;
  }

  public get(pid: number): Process | undefined {
    return this.processes.get(pid);
  }

  public list(): Process[] {
    return Array.from(this.processes.values());
  }

  public setStatus(pid: number, status: Process["status"]): void {
    const process = this.processes.get(pid);
    if (process) {
      process.status = status;
    }
  }

  public setExitCode(pid: number, exitCode: number): void {
    const process = this.processes.get(pid);
    if (process) {
      process.exitCode = exitCode;
    }
  }

  public remove(pid: number): void {
    this.processes.delete(pid);
  }
}
