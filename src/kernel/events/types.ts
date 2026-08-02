import type { Pid, Termination, WindowId } from "../types";

type process_spawned = {
  type: "process.spawned";
  pid: Pid;
  parentPid: Pid;
  path: string;
  at: number;
};
type process_exited = {
  type: "process.exited";
  pid: Pid;
  parentPid: Pid;
  path: string;
  startedAt: number;
  termination: Termination;
};
type window_created = {
  type: "window.created";
  pid: Pid;
  windowId: WindowId;
  title: string;
};
type window_destroyed = {
  type: "window.destroyed";
  pid: Pid;
  windowId: WindowId;
};

export type KernelEvent =
  | process_spawned
  | process_exited
  | window_created
  | window_destroyed;

export type EventType = KernelEvent["type"];

export type EventOf<T extends EventType> = Extract<KernelEvent, { type: T }>;
export type EventHandler<T extends EventType = EventType> = (
  event: EventOf<T>,
) => void;

export interface Subscription {
  id: number;
  types: ReadonlySet<EventType>;
  handler(event: KernelEvent): void;
  active: boolean;
}
