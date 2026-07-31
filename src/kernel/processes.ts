import type { Process } from "./types";

export class ProcessManager {
  private processes: Map<number, Process> = new Map();
  private nextPid: number = 1;

  constructor() {}
}
