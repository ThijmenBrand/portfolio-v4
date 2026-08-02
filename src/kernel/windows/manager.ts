import windowHTML from "./gui/window.html?raw";
import "./gui/window.css";
import type { WindowManagerInterface } from "./managerInterface";
import type {
  Rect,
  WindowCommmands,
  WindowEvents,
  WindowInfo,
  WindowOptions,
  WindowRecord,
  WindowSystemActions,
} from "./types";
import { WindowGeometry, type WindowGeometryInterface } from "./geometry";
import { WindowChrome, type WindowChromeInterface } from "./windowChrome";
import { enableResize } from "./interactions/resize";
import { enableFocus } from "./interactions/focus";
import { enableDrag } from "./interactions/drag";
import { enableControls } from "./interactions/controls";
import type { Pid, WindowId } from "../types";
import { kernelError, logError } from "../errors";

export class WindowManager implements WindowManagerInterface {
  private readonly WindowGeometry: WindowGeometryInterface;
  private readonly WindowChrome: WindowChromeInterface;

  private readonly windowLayer: HTMLElement;
  private readonly actions: WindowSystemActions;
  private readonly events: WindowEvents;

  private windows: Map<number, WindowRecord> = new Map();
  private nextWindowId: number = 1;
  private zCounter: number = 0;
  private focusedId: number | null = null;

  constructor(
    windowLayer: HTMLElement,
    actions: WindowSystemActions,
    events: WindowEvents,
  ) {
    this.WindowGeometry = new WindowGeometry();
    this.WindowChrome = new WindowChrome();

    this.windowLayer = windowLayer;
    this.actions = actions;
    this.events = events;
  }

  public createWindow(options: WindowOptions, ownerPid: Pid): WindowRecord {
    if (!this.windowLayer.isConnected) {
      console.warn("WindowManager: window layer is detached from the document");
    }

    const initialFrame = this.WindowGeometry.initialFrame(options);
    const initialConstraints = this.WindowGeometry.initialConstraints(options);

    const elements = this.WindowChrome.buildWindowChrome(windowHTML);

    const record: WindowRecord = {
      id: this.nextWindowId++ as WindowId,
      ownerPid: ownerPid as Pid,
      root: elements.rootElement,
      titleEl: elements.titleElement,
      bodyEl: elements.bodyElement,
      zIndex: 0,
      closeRequestHandlers: [],
      frame: initialFrame,
      constraints: initialConstraints,
      state: "normal",
      minimized: false,
      disposers: [],
    };

    this.windows.set(record.id, record);
    this.windowLayer.appendChild(elements.rootElement);

    this.WindowChrome.applyFrameToWindow(record);

    const windowCommands = this.createWindowCommands(record);
    record.disposers.push(
      enableResize(record, windowCommands),
      enableFocus(record, windowCommands),
      enableDrag(record, windowCommands),
      enableControls(record, windowCommands),
    );

    this.events.emit({
      type: "window.created",
      pid: ownerPid,
      windowId: record.id,
      title: options.title,
    });

    this.focusWindow(record.id);
    return record;
  }

  public setTitle(windowId: WindowId, title: string): void {
    const windowRecord = this.windows.get(windowId);
    if (!windowRecord) {
      throw kernelError("ENODEV", `Window with ID ${windowId} not found`);
    }

    windowRecord.titleEl.textContent = title;

    this.events.emit({
      type: "window.titleChanged",
      pid: windowRecord.ownerPid,
      windowId: windowRecord.id,
      title: title,
    });
  }

  public moveWindow(windowId: WindowId, x: number, y: number): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state === "maximized") return;

    // prevent frame from going y negative (off the top of the screen)
    if (y < 0) y = 0;

    windowRecord.frame.x = x;
    windowRecord.frame.y = y;

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  public resizeWindow(windowId: WindowId, frame: Rect): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state === "maximized") return;

    windowRecord.frame = this.WindowGeometry.clampToConstraints(
      frame,
      windowRecord.constraints,
    );

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  public setWindowState(
    windowId: WindowId,
    state: "normal" | "maximized",
  ): void {
    const windowRecord = this.getWindowRecord(windowId);
    windowRecord.restoreFrame ??= { ...windowRecord.frame };

    if (state === "normal") {
      windowRecord.state = "normal";
      windowRecord.frame = { ...windowRecord.restoreFrame };
      windowRecord.restoreFrame = undefined;
    } else if (state === "maximized") {
      windowRecord.frame = this.WindowGeometry.maximizedFrame(this.windowLayer);
      windowRecord.state = "maximized";
    }

    this.WindowChrome.applyFrameToWindow(windowRecord);
    this.WindowChrome.applyStateToWindow(
      windowRecord,
      this.focusedId === windowId,
    );
  }

  public setMinimized(windowId: WindowId, minimized: boolean): void {
    const record = this.getWindowRecord(windowId);
    record.minimized = minimized;

    if (minimized && this.focusedId === windowId) {
      this.focusedId = null;
      this.focusTopmostWindow();
    }

    this.WindowChrome.applyStateToWindow(record, this.focusedId === windowId);

    this.events.emit({
      type: "window.minimized",
      pid: record.ownerPid,
      windowId: record.id,
      minimized: minimized,
    });
  }

  public destroy(windowId: WindowId): void {
    const record = this.getWindowRecord(windowId);

    record.disposers.forEach((dispose) => {
      try {
        dispose();
      } catch (error) {
        logError(`Error disposing resources for window ${windowId}: ${error}`);
      }
    });
    record.disposers.length = 0;

    record.root.remove();
    this.windows.delete(windowId);

    if (this.focusedId === windowId) {
      this.focusedId = null;
      this.focusTopmostWindow();
    }

    this.events.emit({
      type: "window.destroyed",
      pid: record.ownerPid,
      windowId: record.id,
    });
  }

  public addCloseRequestHandler(windowId: WindowId, handler: () => void): void {
    const windowRecord = this.getWindowRecord(windowId);

    windowRecord.closeRequestHandlers.push(handler);
  }

  public validateWindowOwnership(windowId: WindowId, pid: Pid): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.ownerPid !== pid) {
      throw kernelError(
        "ENODEV",
        `Process ${pid} does not own window ${windowId}`,
      );
    }
  }

  public focusWindow(windowId: WindowId): void {
    if (this.focusedId === windowId) return;

    const record = this.getWindowRecord(windowId);
    const previousId = this.focusedId;

    this.focusedId = windowId;
    record.minimized = false;
    record.zIndex = ++this.zCounter;

    if (previousId !== null) {
      const previous = this.windows.get(previousId);
      if (previous) {
        this.WindowChrome.applyStateToWindow(previous, false);
      }
    }

    this.WindowChrome.applyStateToWindow(record, true);

    this.events.emit({
      type: "window.focused",
      pid: record.ownerPid,
      windowId: record.id,
    });
    this.events.emit({
      type: "window.minimized",
      pid: record.ownerPid,
      windowId: record.id,
      minimized: false,
    });
  }

  public releaseFor(pid: Pid): void {
    const windowsToRelease = Array.from(this.windows.values()).filter(
      (record) => record.ownerPid === pid,
    );

    for (const record of windowsToRelease) {
      try {
        this.destroy(record.id);
      } catch (error) {
        logError(
          `Error destroying window ${record.id} for PID ${pid}: ${error}`,
        );
      }
    }

    this.focusTopmostWindow();
  }

  public requestClose(windowId: WindowId): void {
    const record = this.getWindowRecord(windowId);

    if (record.closeRequestHandlers.length === 0) {
      this.actions.defaultClose(windowId, record.ownerPid);
      return;
    }

    if (record.closeRequestedAt !== undefined) {
      this.actions.forceClose(windowId, record.ownerPid);
      return;
    }

    record.closeRequestedAt = Date.now();
    for (const handler of [...record.closeRequestHandlers]) {
      try {
        handler();
      } catch (error) {
        logError(
          `Error in close request handler for window ${windowId}: ${error}`,
        );
      }
    }
  }

  public windowCountFor(pid: Pid): number {
    return Array.from(this.windows.values()).filter(
      (record) => record.ownerPid === pid,
    ).length;
  }

  public listWindows(): WindowInfo[] {
    return Array.from(this.windows.values()).map((record) => ({
      windowId: record.id,
      pid: record.ownerPid,
      title: record.titleEl.textContent || "",
      minimized: record.minimized,
      state: record.state,
      focused: this.focusedId === record.id,
    }));
  }

  private focusTopmostWindow(): void {
    let topmost: WindowRecord | null = null;

    for (const record of this.windows.values()) {
      if (record.minimized) continue;
      if (!topmost || record.zIndex > topmost.zIndex) topmost = record;
    }

    if (topmost) {
      this.focusWindow(topmost.id);
    }
  }

  private createWindowCommands(windowRecord: WindowRecord): WindowCommmands {
    return {
      moveWindow: (x: number, y: number) =>
        this.moveWindow(windowRecord.id, x, y),
      resizeWindow: (frame: Rect) => this.resizeWindow(windowRecord.id, frame),
      setWindowState: (state: "normal" | "maximized") =>
        this.setWindowState(windowRecord.id, state),
      minimizeWindow: () => this.setMinimized(windowRecord.id, true),
      focusWindow: () => this.focusWindow(windowRecord.id),
      requestClose: () => this.requestClose(windowRecord.id),
    };
  }

  private getWindowRecord(windowId: WindowId): WindowRecord {
    const windowRecord = this.windows.get(windowId);
    if (!windowRecord) {
      throw kernelError("ENODEV", `Window with ID ${windowId} not found`);
    }
    return windowRecord;
  }
}
