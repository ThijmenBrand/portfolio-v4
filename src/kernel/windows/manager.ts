import windowHTML from "./gui/window.html?raw";
import "./gui/window.css";
import type { WindowManagerInterface } from "./managerInterface";
import type {
  WindowCommmands,
  WindowEvents,
  WindowInfo,
  WindowOptions,
  WindowRecord,
  WindowSystemActions,
  WorkArea,
} from "./types";
import { WindowGeometry, type WindowGeometryInterface } from "./geometry";
import { WindowChrome, type WindowChromeInterface } from "./windowChrome";
import { enableResize } from "./interactions/resize";
import { enableFocus } from "./interactions/focus";
import { enableDrag } from "./interactions/drag";
import { enableControls } from "./interactions/controls";
import type { Pid, Rect, WindowId } from "../types";
import { kernelError, logError } from "../errors";
import { isPhone } from "../../utils/phone";

/**
 * Second ✕ on a window whose app is handling a close request:
 *  - within DOUBLE_CLICK_MS: ignored (a double-click is not "force quit");
 *  - within FORCE_WINDOW_MS: the user insists → force close (SIGKILL);
 *  - later: the app evidently answered (e.g. the user picked Cancel), so
 *    this is a NEW request and the app is asked again.
 */
const DOUBLE_CLICK_MS = 500;
const FORCE_WINDOW_MS = 5000;

export class WindowManager implements WindowManagerInterface {
  private readonly WindowGeometry: WindowGeometryInterface;
  private readonly WindowChrome: WindowChromeInterface;

  private readonly windowLayer: HTMLElement;
  private readonly actions: WindowSystemActions;
  private readonly events: WindowEvents;
  private readonly workArea: WorkArea;

  private windows: Map<number, WindowRecord> = new Map();
  private nextWindowId: number = 1;
  private zCounter: number = 0;
  private focusedId: number | null = null;

  constructor(
    windowLayer: HTMLElement,
    actions: WindowSystemActions,
    events: WindowEvents,
    workArea: WorkArea,
  ) {
    this.WindowGeometry = new WindowGeometry();
    this.WindowChrome = new WindowChrome();

    this.windowLayer = windowLayer;
    this.actions = actions;
    this.events = events;
    this.workArea = workArea;

    // Ctrl+W closes the focused window. Ctrl only: browsers reserve Cmd+W.
    // App frames forward it (iframe-entry.ts → realm.ts).
    document.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() !== "w" || !event.ctrlKey || event.metaKey) return;
      if (this.focusedId === null) return;
      event.preventDefault();
      this.requestClose(this.focusedId as WindowId);
    });
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
    if (isPhone()) this.setWindowState(record.id, "maximized");

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

  /** Change only the size, keeping the position (clamped like any resize). */
  public resizeTo(windowId: WindowId, width: number, height: number): void {
    const { frame } = this.getWindowRecord(windowId);
    this.resizeWindow(windowId, { ...frame, width, height });
  }

  public setWindowState(
    windowId: WindowId,
    state: "normal" | "maximized",
  ): void {
    const windowRecord = this.getWindowRecord(windowId);
    // Phones have no floating windows: the title-bar double-click can't restore.
    if (state === "normal" && isPhone()) return;
    windowRecord.restoreFrame ??= { ...windowRecord.frame };

    if (state === "normal") {
      windowRecord.state = "normal";
      windowRecord.frame = { ...windowRecord.restoreFrame };
      windowRecord.restoreFrame = undefined;
    } else if (state === "maximized") {
      windowRecord.frame = this.maximizedFrame();
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
    if (minimized) this.animateMinimize(record);

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
    this.focusContent(record);

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
          `Error destroying window ${record.id} for process ${pid}: ${error}`,
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

    const now = Date.now();
    if (record.closeRequestedAt !== undefined) {
      const sinceAsked = now - record.closeRequestedAt;
      if (sinceAsked < DOUBLE_CLICK_MS) return;
      if (sinceAsked <= FORCE_WINDOW_MS) {
        this.actions.forceClose(windowId, record.ownerPid);
        return;
      }
      // Too long ago to count as insisting: fall through and ask again.
    }

    record.closeRequestedAt = now;
    for (const handler of [...record.closeRequestHandlers]) {
      try {
        handler();
      } catch (error) {
        this.actions.fault(record.ownerPid, error, "window");
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

  public reflowMaximized(): void {
    const phone = isPhone();
    for (const record of this.windows.values()) {
      // Shrinking into phone mode (rotation, narrow browser) maximizes floating windows too.
      if (phone && record.state !== "maximized") {
        this.setWindowState(record.id, "maximized");
        continue;
      }
      if (record.state !== "maximized") continue;
      record.frame = this.maximizedFrame();
      this.WindowChrome.applyFrameToWindow(record);
    }
  }

  public attachSheet(windowId: WindowId, el: HTMLElement): () => void {
    const record = this.getWindowRecord(windowId);
    const sheet = document.createElement("div");
    sheet.className = "window-sheet";
    sheet.append(el);
    record.bodyEl.append(sheet);
    if (this.focusedId === windowId) this.focusContent(record);
    else this.focusWindow(windowId);

    return () => {
      sheet.remove();
      if (this.focusedId === windowId && this.windows.has(windowId))
        this.focusContent(record);
    };
  }

  /**
   * Shrink the window into its taskbar button. The taskbar marks buttons with
   * data-minimize-target only when the user wants this (Settings); no target
   * or reduced motion means the window just disappears.
   */
  private animateMinimize(record: WindowRecord): void {
    const target = document.querySelector(`[data-minimize-target="${record.ownerPid}"]`);
    if (!target || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const from = record.root.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = Math.min(to.width / from.width, to.height / from.height);

    // .minimizing keeps the window drawn under .minimized until the animation ends.
    record.root.classList.add("minimizing");
    record.root
      .animate(
        [
          { transform: "none", opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
        ],
        { duration: 280, easing: "cubic-bezier(0.4, 0, 1, 1)" },
      )
      .finished.catch(() => {}) // cancelled by a restore mid-flight
      .finally(() => record.root.classList.remove("minimizing"));
  }

  /** Fullscreen: maximized windows cover the whole screen (topbar and dock auto-hide over them). */
  private maximizedFrame(): Rect {
    const area = this.workArea.get();
    // Touch has no hover to reveal the bars (taskbar.css keeps them out on phones): fit between them.
    if (isPhone()) return area;
    return { x: area.x, y: 0, width: area.width, height: window.innerHeight };
  }

  /**
   * Keyboard goes where the window is: for an iframe app, raising its window
   * must also move focus INTO the iframe, or typing would go nowhere. (No
   * loop with interactions/focus.ts: focusWindow returns early when the
   * window is already focused.)
   */
  private focusContent(record: WindowRecord): void {
    const sheet = record.bodyEl.querySelector<HTMLElement>(
      ".window-sheet > *",
    );
    if (sheet) return sheet.focus();
    const frame = record.bodyEl.querySelector("iframe");
    if (frame && document.activeElement !== frame) frame.focus();
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
      refocusActive: () => {
        const active =
          this.focusedId === null ? undefined : this.windows.get(this.focusedId);
        if (active) this.focusContent(active);
      },
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
