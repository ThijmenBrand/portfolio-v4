import type { ProcessManager } from "./processes";
import type { WindowManager } from "./windows";

export class KernelCore {
  private readonly windows: WindowManager;
  private readonly processes: ProcessManager;

  constructor(windowManager: WindowManager, processManager: ProcessManager) {
    this.windows = windowManager;
    this.processes = processManager;
  }
}
