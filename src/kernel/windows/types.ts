import type { KernelEvent } from "../events/types";
import type { FaultSite } from "../proc/types";
import type { Pid, WindowId } from "../types";

export interface WindowOptions {
  title: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface WindowRecord {
  id: WindowId;
  ownerPid: Pid;
  root: HTMLElement;
  titleEl: HTMLElement;
  bodyEl: HTMLElement;
  zIndex: number;
  closeRequestHandlers: Array<() => void>;
  closeRequestedAt?: number;
  frame: Rect;
  restoreFrame?: Rect;
  state: "normal" | "maximized";
  minimized: boolean;
  constraints: Constraints;
  disposers: Array<() => void>;
}

export interface WindowHandle {
  readonly id: WindowId;
  readonly body: HTMLElement;
  setTitle(title: string): void;
  close(): void;
  onCloseRequest(callback: () => void): void;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Constraints {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface WindowCommmands {
  moveWindow(x: number, y: number): void;
  resizeWindow(frame: Rect): void;
  setWindowState(state: "normal" | "maximized"): void;
  minimizeWindow(): void;
  focusWindow(): void;
  requestClose(): void;
}

export interface WindowSystemActions {
  defaultClose(windowId: WindowId, ownerPid: Pid): void;
  forceClose(windowId: WindowId, ownerPid: Pid): void;
  fault(pid: Pid, error: unknown, site: FaultSite): void;
}

export type WindowEvent = Extract<KernelEvent, { type: `window.${string}` }>;

export interface WindowEvents {
  emit(event: WindowEvent): void;
}

export interface WindowInfo {
  windowId: WindowId;
  pid: Pid;
  title: string;
  minimized: boolean;
  state: "normal" | "maximized";
  focused: boolean;
}
