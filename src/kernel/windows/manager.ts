import windowHTML from "./gui/window.html?raw";
import "./gui/window.css";
import type { WindowManagerInterface } from "./managerInterface";
import type {
  Rect,
  WindowCommmands,
  WindowOptions,
  WindowRecord,
} from "./types";
import { WindowGeometry, type WindowGeometryInterface } from "./geometry";
import { WindowChrome, type WindowChromeInterface } from "./windowChrome";
import { enableResize } from "./interactions/resize";
import { enableFocus } from "./interactions/focus";
import { enableDrag } from "./interactions/drag";
import { enableControls } from "./interactions/controls";

export class WindowManager implements WindowManagerInterface {
  private readonly WindowGeometry: WindowGeometryInterface;
  private readonly WindowChrome: WindowChromeInterface;

  private readonly windowLayer: HTMLElement;

  private windows: Map<number, WindowRecord> = new Map();
  private nextWindowId: number = 1;
  private zCounter: number = 0;
  private focusedId: number | null = null;

  constructor(windowLayer: HTMLElement) {
    this.WindowGeometry = new WindowGeometry();
    this.WindowChrome = new WindowChrome();

    this.windowLayer = windowLayer;
  }

  public createWindow(options: WindowOptions, ownerPid: number): WindowRecord {
    const initialFrame = this.WindowGeometry.initialFrame(options);
    const initialConstraints = this.WindowGeometry.initialConstraints(options);

    const elements = this.WindowChrome.buildWindowChrome(windowHTML);

    const record: WindowRecord = {
      id: this.nextWindowId++,
      ownerPid,
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

    this.handleWindowFocus(record.id);
    return record;
  }

  public setTitle(windowId: number, title: string): void {
    const windowRecord = this.windows.get(windowId);
    if (!windowRecord) {
      throw new Error(`Window with ID ${windowId} not found`);
    }

    windowRecord.titleEl.textContent = title;
  }

  public moveWindow(windowId: number, x: number, y: number): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state === "maximized") return;

    windowRecord.frame.x = x;
    windowRecord.frame.y = y;

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  public resizeWindow(windowId: number, frame: Rect): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state === "maximized") return;

    windowRecord.frame = this.WindowGeometry.clampToConstraints(
      frame,
      windowRecord.constraints,
    );

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  public setWindowState(windowId: number, state: "normal" | "maximized"): void {
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

  public setMinimized(windowId: number, minimized: boolean): void {
    const record = this.getWindowRecord(windowId);
    record.minimized = minimized;

    if (minimized && this.focusedId === windowId) {
      this.focusedId = null;
      this.focusTopmostWindow();
    }

    this.WindowChrome.applyStateToWindow(record, this.focusedId === windowId);
  }

  public destroy(windowId: number): void {
    const record = this.getWindowRecord(windowId);

    record.disposers.forEach((dispose) => dispose());
    record.disposers.length = 0;

    record.root.remove();
    this.windows.delete(windowId);

    if (this.focusedId === windowId) {
      this.focusedId = null;
      this.focusTopmostWindow();
    }
  }

  public addCloseRequestHandler(windowId: number, handler: () => void): void {
    const windowRecord = this.getWindowRecord(windowId);

    windowRecord.closeRequestHandlers.push(handler);
  }

  public requestClose(windowId: number): void {
    const windowRecord = this.getWindowRecord(windowId);

    windowRecord.closeRequestHandlers.forEach((handler) => {
      try {
        handler();
      } catch (error) {
        console.error(
          `Error in close request handler for window ${windowId}:`,
          error,
        );
      }
    });
  }

  public validateWindowOwnership(windowId: number, pid: number): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.ownerPid !== pid) {
      throw new Error(
        `Process ${pid} does not own window ${windowId} (owned by ${windowRecord.ownerPid})`,
      );
    }
  }

  public handleWindowFocus(windowId: number): void {
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
  }

  public releaseFor(pid: number): void {
    const windowsToRelease = Array.from(this.windows.values()).filter(
      (record) => record.ownerPid === pid,
    );

    for (const record of windowsToRelease) {
      try {
        this.destroy(record.id);
      } catch (error) {
        console.error(
          `Error destroying window ${record.id} for PID ${pid}:`,
          error,
        );
      }
    }

    this.focusTopmostWindow();
  }

  private focusTopmostWindow(): void {
    let topmost: WindowRecord | null = null;

    for (const record of this.windows.values()) {
      if (record.minimized) continue;
      if (!topmost || record.zIndex > topmost.zIndex) topmost = record;
    }

    if (topmost) {
      this.handleWindowFocus(topmost.id);
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
      focusWindow: () => this.handleWindowFocus(windowRecord.id),
      requestClose: () => this.requestClose(windowRecord.id),
    };
  }

  private getWindowRecord(windowId: number): WindowRecord {
    const windowRecord = this.windows.get(windowId);
    if (!windowRecord) {
      throw new Error(`Window with ID ${windowId} not found`);
    }
    return windowRecord;
  }
}
