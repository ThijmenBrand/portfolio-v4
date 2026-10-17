import type { KernelEvent } from "../events/types";
import type { FaultSite } from "../proc/types";
import type { Pid, Rect, WindowId } from "../types";
import type { Edge, SnapTarget, TileZone } from "./snap";

export type WindowState = "normal" | "maximized" | "tiled";

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
  translucent?: boolean;
  titleBar?: "default" | "hidden";
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
  /** The last floating frame: what restore (and dragging out of a tile) goes back to. */
  restoreFrame?: Rect;
  state: WindowState;
  /** Set while state is "tiled". */
  tile?: TileZone;
  minimized: boolean;
  constraints: Constraints;
  disposers: Array<() => void>;
}

/** Wire-safe window handle: what any app, in any realm, gets back. */
export interface WindowHandle {
  readonly id: WindowId;
  setTitle(title: string): Promise<void>;
  close(): Promise<void>;
  onCloseRequest(callback: () => void): Promise<void>;
}

/** In-realm only: the window's content element, lent from the kernel's document. */
export interface ElementWindowHandle extends WindowHandle {
  readonly body: HTMLElement;
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
  /** A drag is leaving a tile or maximize: float again at the restore size, under the pointer. */
  unsnapForDrag(pointer: { x: number; y: number }): void;
  /** The snap target under the pointer, if snapping may put this window there. */
  snapTargetAt(x: number, y: number): SnapTarget | null;
  /** Show (or with null, hide) where the window would land. */
  previewSnap(target: SnapTarget | null): void;
  snapTo(target: SnapTarget): void;
  /** A resize of these edges starts: true if they are shared tile edges (the split moves). */
  beginSplitResize(edges: ReadonlySet<Edge>): boolean;
  /** Move the split by the pointer's travel since beginSplitResize. */
  moveSplit(dx: number, dy: number): void;
  /** A resize of an outer edge: the window floats, keeping its frame. */
  float(): void;
  /** The pointer entered or left the maximize button: the layouts picker opens after a pause. */
  hoverLayouts(button: HTMLElement, over: boolean): void;
  closeLayouts(): void;
  minimizeWindow(): void;
  focusWindow(): void;
  requestClose(): void;
  /** Give the keyboard back to whichever window is focused now. */
  refocusActive(): void;
}

export interface WorkArea {
  get(): Rect;
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
  state: WindowState;
  tile?: TileZone;
  frame: Rect;
  focused: boolean;
}

/** User-space policy over the kernel's mechanics (windows.setPolicy, from the Taskbar). */
export interface WindowPolicy {
  /** Dragging a window to a screen edge snaps it. */
  snap: boolean;
}
