import type { Pid, WindowId } from "../types";
import type { Arrow, SnapTarget } from "./snap";
import type {
  WindowInfo,
  WindowOptions,
  WindowPolicy,
  WindowRecord,
} from "./types";

export interface WindowManagerInterface {
  createWindow(options: WindowOptions, ownerPid: Pid): WindowRecord;
  setTitle(windowId: WindowId, title: string): void;
  resizeTo(windowId: WindowId, width: number, height: number): void;
  setAppearance(windowId: WindowId, options: WindowOptions): void;
  destroy(windowId: WindowId): void;
  addCloseRequestHandler(windowId: WindowId, handler: () => void): void;
  requestClose(windowId: WindowId): void;
  cycleFocus(): void;
  validateWindowOwnership(windowId: WindowId, pid: Pid): void;
  releaseFor(pid: Pid): void;
  windowCountFor(pid: Pid): number;
  listWindows(): Array<WindowInfo>;
  focusWindow(windowId: WindowId): void;
  setMinimized(windowId: WindowId, minimized: boolean): void;
  reflowLayout(): void;
  arrange(windowId: WindowId, target: SnapTarget | "restore"): void;
  keyTile(windowId: WindowId, arrow: Arrow): void;
  setPolicy(policy: WindowPolicy): void;
  attachSheet(windowId: WindowId, el: HTMLElement): () => void;
}
