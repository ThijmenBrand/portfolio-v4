import type { WindowOptions, WindowRecord } from "./types";

export interface WindowManagerInterface {
  createWindow(options: WindowOptions, ownerPid: number): WindowRecord;
  setTitle(windowId: number, title: string): void;
  destroy(windowId: number): void;
  addCloseRequestHandler(windowId: number, handler: () => void): void;
  requestClose(windowId: number): void;
  validateWindowOwnership(windowId: number, pid: number): void;
  releaseFor(pid: number): void;
}
