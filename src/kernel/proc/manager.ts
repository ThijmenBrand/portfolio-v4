import { eperm, esrch, kernelError, logError } from "../errors";
import type {
  ExitRecord,
  Pid,
  Process,
  ProcessInfo,
  ProcessInit,
  ProcessSignal,
  Termination,
} from "../types";
import type { Signal } from "./signals";

export interface ProcessManagerInterface {
  allocate(init: ProcessInit): Process;
  get(pid: Pid): Process | undefined;
  list(): ProcessInfo[];
  setStatus(pid: Pid, status: Process["status"]): void;
  childrenOf(pid: Pid): Process[];
  reparentChildren(from: Pid, to: Pid): void;
  registerResource(pid: Pid, kind: string, dispose: () => void): number;
  unregisterResource(pid: Pid, resourceId: number): void;
  disposeResources(pid: Pid): void;
  setTermination(pid: Pid, termination: Termination): void;
  setSignalHandler(pid: Pid, signal: Signal, handler: () => void): () => void;
  getSignal(pid: Pid): ProcessSignal;
  resolveWaiters(pid: Pid): void;
  addWaiter(pid: Pid, waiter: (termination: Termination) => void): () => void;
  reap(pid: Pid): void;
  history(): readonly ExitRecord[];
}

export class ProcessManager implements ProcessManagerInterface {
  private readonly processes: Map<Pid, Process>;

  private nextProcessId: Pid;
  private exitHistory: ExitRecord[];
  private static readonly HISTORY_LIMIT = 50;

  constructor() {
    this.nextProcessId = 0 as Pid;
    this.processes = new Map();
    this.exitHistory = [];
  }

  public allocate(init: ProcessInit): Process {
    const pid = this.nextProcessId++ as Pid;
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

  public get(pid: Pid): Process | undefined {
    return this.processes.get(pid);
  }

  public list(): ProcessInfo[] {
    return Array.from(this.processes.values()).map((p) => ({
      pid: p.pid,
      parentPid: p.parentPid,
      privileged: p.privileged,
      args: p.args,
      path: p.path,
      status: p.status,
      startedAt: p.startedAt,
    }));
  }

  public setStatus(pid: Pid, status: Process["status"]): void {
    const process = this.processes.get(pid);
    if (process) {
      process.status = status;
    }
  }

  public childrenOf(pid: Pid): Process[] {
    return Array.from(this.processes.values()).filter(
      (proc) => proc.parentPid === pid,
    );
  }

  public reparentChildren(from: Pid, to: Pid): void {
    for (const proc of this.processes.values()) {
      if (proc.parentPid === from) {
        proc.parentPid = to;
      }
    }
  }

  public registerResource(pid: Pid, kind: string, dispose: () => void): number {
    const process = this.processes.get(pid);
    if (!process) {
      throw esrch(pid);
    }

    const resourceId = process.nextResourceId++;
    process.resources.set(resourceId, { id: resourceId, kind, dispose });
    return resourceId;
  }

  public unregisterResource(pid: Pid, resourceId: number): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw esrch(pid);
    }

    process.resources.delete(resourceId);
  }

  public disposeResources(pid: Pid): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw esrch(pid);
    }

    const resources = Array.from(process.resources.values());
    process.resources.clear();

    for (const resource of resources) {
      try {
        resource.dispose();
      } catch (error) {
        logError(
          `Error disposing resource ${resource.id} of kind ${resource.kind}: ${error}`,
        );
      }
    }
  }

  public reap(pid: Pid): void {
    const process = this.processes.get(pid);
    if (!process || !process.termination) {
      throw esrch(pid);
    }

    if (process.status !== "zombie") {
      throw eperm(pid);
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

  public setSignalHandler(
    pid: Pid,
    signal: Signal,
    handler: () => void,
  ): () => void {
    const proc = this.processes.get(pid);
    if (!proc) {
      throw esrch(pid);
    }

    proc.signalHandlers.set(signal, handler);

    return () => {
      if (proc.signalHandlers.get(signal) === handler) {
        proc.signalHandlers.delete(signal);
      }
    };
  }

  public getSignal(pid: Pid): ProcessSignal {
    const proc = this.processes.get(pid);
    if (!proc) {
      throw esrch(pid);
    }

    return proc.abortController.signal;
  }

  public setTermination(pid: Pid, termination: Termination): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw esrch(pid);
    }

    process.termination = termination;
  }

  public resolveWaiters(pid: Pid): void {
    const process = this.processes.get(pid);
    if (!process) {
      throw esrch(pid);
    }

    if (!process.termination) {
      throw kernelError(`Process ${pid} has no termination record`);
    }

    const waiters = Array.from(process.waiters);
    process.waiters.length = 0;

    for (const waiter of waiters) {
      try {
        waiter(process.termination);
      } catch (error) {
        logError(`Error occurred while resolving waiter: ${error}`);
      }
    }
  }

  public addWaiter(
    pid: Pid,
    waiter: (termination: Termination) => void,
  ): () => void {
    const process = this.processes.get(pid);
    if (!process) throw esrch(pid);

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
