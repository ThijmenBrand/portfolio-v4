import type { DisplayInterface } from "./display";
import type { EventBusInterface } from "./events/bus";
import type { ProcessManagerInterface } from "./proc/manager";
import type { KernelInterface, Pid } from "./types";
import type { WindowManagerInterface } from "./windows/managerInterface";

export interface KernelContext {
  processes: ProcessManagerInterface;
  windows: WindowManagerInterface;
  display: DisplayInterface;
  events: EventBusInterface;
  createOs(pid: Pid): KernelInterface;
}
