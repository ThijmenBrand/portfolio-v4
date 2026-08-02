import type { Pid, WindowId } from "../types";
import type { WindowInfo, WindowOptions, WindowRecord } from "./types";

export interface WindowManagerInterface {
  createWindow(options: WindowOptions, ownerPid: Pid): WindowRecord;
  setTitle(windowId: WindowId, title: string): void;
  destroy(windowId: WindowId): void;
  addCloseRequestHandler(windowId: WindowId, handler: () => void): void;
  requestClose(windowId: WindowId): void;
  validateWindowOwnership(windowId: WindowId, pid: Pid): void;
  releaseFor(pid: Pid): void;
  windowCountFor(pid: Pid): number;
  listWindows(): Array<WindowInfo>;
  focusWindow(windowId: WindowId): void;
  setMinimized(windowId: WindowId, minimized: boolean): void;
}
