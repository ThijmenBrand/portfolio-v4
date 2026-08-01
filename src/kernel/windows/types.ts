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
  id: number;
  ownerPid: number;
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
  readonly id: number;
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
  defaultClose(windowId: number, ownerPid: number): void;
  forceClose(windowId: number, ownerPid: number): void;
}
