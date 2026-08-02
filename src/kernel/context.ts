import type { DisplayInterface } from "./display";
import type { ProcessManagerInterface } from "./proc/manager";
import type { KernelInterface, Pid } from "./types";
import type { WindowManagerInterface } from "./windows/managerInterface";

export interface KernelContext {
  processes: ProcessManagerInterface;
  windows: WindowManagerInterface;
  display: DisplayInterface;
  createOs(pid: Pid): KernelInterface;
}
