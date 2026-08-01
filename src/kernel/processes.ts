import type { ExitRecord, Process, ProcessInit, Termination } from "./types";

export interface ProcessManagerInterface {
  allocate(init: ProcessInit): Process;
  get(pid: number): Process | undefined;
  list(): Process[];
  setStatus(pid: number, status: Process["status"]): void;
  childrenOf(pid: number): Process[];
  reparentChildren(from: number, to: number): void;
  registerResource(pid: number, kind: string, dispose: () => void): number;
  unregisterResource(pid: number, resourceId: number): void;
  disposeResources(pid: number): void;
  setTermination(pid: number, termination: Termination): void;
  resolveWaiters(pid: number): void;
  addWaiter(
    pid: number,
    waiter: (termination: Termination) => void,
  ): () => void;
  reap(pid: number): void;
  history(): readonly ExitRecord[];
}

export class ProcessManager implements ProcessManagerInterface {
  private readonly processes: Map<number, Process>;

  private nextProcessId: number;
  private exitHistory: ExitRecord[];
  private static readonly HISTORY_LIMIT = 50;

  constructor() {
    this.nextProcessId = 0;
    this.processes = new Map();
    this.exitHistory = [];
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
      startedAt: Date.now(),
      resources: new Map(),
      nextResourceId: 0,
      termination: {
        code: 0,
        reason: "exit",
        at: 0,
      },
      waiters: [],
      abortController: new AbortController(),
      signalHandlers: new Map(),
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

  public childrenOf(pid: number): Process[] {
    return Array.from(this.processes.values()).filter(
      (proc) => proc.parentPid === pid,
    );
  }

  public reparentChildren(from: number, to: number): void {
    for (const proc of this.processes.values()) {
      if (proc.parentPid === from) {
        proc.parentPid = to;
      }
    }
  }

  public registerResource(
    pid: number,
    kind: string,
    dispose: () => void,
  ): number {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    const resourceId = process.nextResourceId++;
    process.resources.set(resourceId, { id: resourceId, kind, dispose });
    return resourceId;
  }

  public unregisterResource(pid: number, resourceId: number): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    process.resources.delete(resourceId);
  }

  public disposeResources(pid: number): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    const resources = Array.from(process.resources.values());
    process.resources.clear();

    for (const resource of resources) {
      try {
        resource.dispose();
      } catch (error) {
        console.error(`Error occurred while disposing resource: ${error}`);
      }
    }
  }

  reap(pid: number): void {
    const process = this.processes.get(pid);
    if (!process || !process.termination) {
      return;
    }

    if (process.status !== "zombie") {
      throw new Error(`Cannot reap process ${pid} that is not a zombie`);
    }

    // Add to exit history
    this.exitHistory.push({
      pid: process.pid,
      parentPid: process.parentPid,
      path: process.path,
      startedAt: process.startedAt,
      termination: process.termination,
    });

    // Limit history size
    if (this.exitHistory.length > ProcessManager.HISTORY_LIMIT) {
      this.exitHistory.shift();
    }

    // Remove the process from the active list
    this.processes.delete(pid);
  }

  setTermination(pid: number, termination: Termination): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    process.termination = termination;
  }

  resolveWaiters(pid: number): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`ESRCH: No such process, ${pid}`);
    }

    if (!process.termination) {
      throw new Error(`Process ${pid} has no termination record`);
    }

    const waiters = Array.from(process.waiters);
    process.waiters.length = 0;

    for (const waiter of waiters) {
      try {
        waiter(process.termination);
      } catch (error) {
        console.error(`Error occurred while resolving waiter: ${error}`);
      }
    }
  }

  addWaiter(
    pid: number,
    waiter: (termination: Termination) => void,
  ): () => void {
    const process = this.processes.get(pid);
    if (!process) throw new Error(`ESRCH: No such process, ${pid}`);

    process.waiters.push(waiter);
    return () => {
      const index = process.waiters.indexOf(waiter);
      if (index !== -1) process.waiters.splice(index, 1);
    };
  }

  history(): readonly ExitRecord[] {
    return [...this.exitHistory];
  }
}
