import windowHTML from "./gui/window.html?raw";
import "./gui/window.css";
import type { WindowManagerInterface } from "./managerInterface";
import type {
  WindowCommmands,
  WindowEvents,
  WindowInfo,
  WindowOptions,
  WindowPolicy,
  WindowRecord,
  WindowSystemActions,
  WorkArea,
} from "./types";
import {
  EVEN_SPLIT,
  innerEdges,
  keyStep,
  splitBounds,
  stretchFrame,
  tileFrame,
  unsnapFrame,
  zoneAt,
  type Arrow,
  type Edge,
  type SnapTarget,
  type Split,
  type TileZone,
} from "./snap";
import { SnapLayouts } from "./snapLayouts";
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

/** Title bar height (window.css): a window dragged out of a tile is grabbed inside it. */
const TITLE_BAR = 34;

/** .window border width (window.css): floating windows are content-box, so it sits outside the frame. */
const BORDER = 1;

/** Overlays keep this far from the screen's edges. */
const OVERLAY_MARGIN = 12;
/** An overlay's top edge, as a share of the screen's height (phones: OVERLAY_MARGIN). */
const OVERLAY_TOP = 0.18;

const ARROWS: Record<string, Arrow> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export class WindowManager implements WindowManagerInterface {
  private readonly WindowGeometry: WindowGeometryInterface;
  private readonly WindowChrome: WindowChromeInterface;

  private readonly windowLayer: HTMLElement;
  private readonly overlayLayer: HTMLElement;
  private readonly actions: WindowSystemActions;
  private readonly events: WindowEvents;
  private readonly workArea: WorkArea;

  private windows: Map<number, WindowRecord> = new Map();
  private nextWindowId: number = 1;
  private zCounter: number = 0;
  private focusedId: number | null = null;

  /** Where tiles meet. Shared by every tiled window; reset when the first one tiles. */
  private split: Split = { ...EVEN_SPLIT };
  /** A shared-edge resize in progress: which edges, and the split it started from. */
  private splitDrag: { edges: ReadonlySet<Edge>; start: Split } | undefined;
  private policy: WindowPolicy = { snap: true };
  private preview: HTMLElement | undefined;
  private previewOwner: WindowId | null = null;
  private readonly layouts: SnapLayouts;
  /** The size each overlay's app asked for; placeOverlay fits it to the screen. */
  private readonly overlaySizes = new Map<WindowId, { width: number; height: number }>();

  constructor(
    windowLayer: HTMLElement,
    actions: WindowSystemActions,
    events: WindowEvents,
    workArea: WorkArea,
    overlayLayer: HTMLElement,
  ) {
    this.WindowGeometry = new WindowGeometry();
    this.WindowChrome = new WindowChrome();

    this.windowLayer = windowLayer;
    this.overlayLayer = overlayLayer;
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

    // Ctrl/Cmd+` cycles window focus. Cmd+` only arrives if macOS "Move focus to next window" is unbound.
    document.addEventListener("keydown", (event) => {
      if (event.code !== "Backquote" || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      this.cycleFocus();
    });

    // Ctrl+Alt+Arrow snaps the focused window. App frames forward it (frame.ts → realm.ts).
    document.addEventListener("keydown", (event) => {
      const arrow = ARROWS[event.key];
      if (!arrow || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
      if (this.focusedId === null) return;
      event.preventDefault();
      this.keyTile(this.focusedId as WindowId, arrow);
    });

    // A press anywhere in our document but on an overlay puts it away, like
    // a popover. Presses inside app frames never get here: the overlay's own
    // app sees its frame lose focus, and focusWindow below hides it too.
    document.addEventListener(
      "pointerdown",
      (event) => {
        for (const record of this.windows.values()) {
          if (record.kind !== "overlay" || record.hidden) continue;
          if (!record.root.contains(event.target as Node)) this.setVisible(record.id, false);
        }
      },
      true,
    );

    this.layouts = new SnapLayouts(windowLayer, {
      topZ: () => this.zCounter + 1,
      preview: (windowId, zone) => {
        const record = this.windows.get(windowId);
        // Over its own window: picking from the menu doesn't move the window out of the way.
        if (record) this.showPreview(record, zone, true);
      },
      pick: (windowId, zone) => {
        if (!this.windows.has(windowId)) return;
        this.tileWindow(windowId, zone);
        this.focusWindow(windowId);
      },
    });
  }

  public setPolicy(policy: WindowPolicy): void {
    this.policy = { snap: policy.snap !== false };
  }

  /** Raise the bottom-most visible window: repeated presses round-robin through all of them. */
  public cycleFocus(): void {
    // ponytail: no MRU switcher overlay; add one if round-robin feels wrong with many windows.
    let bottom: WindowRecord | undefined;
    for (const record of this.windows.values()) {
      if (record.minimized || record.kind === "overlay") continue;
      if (!bottom || record.zIndex < bottom.zIndex) bottom = record;
    }
    if (bottom) this.focusWindow(bottom.id);
  }

  public createWindow(options: WindowOptions, ownerPid: Pid): WindowRecord {
    if (!this.windowLayer.isConnected) {
      console.warn("WindowManager: window layer is detached from the document");
    }
    if (options.surface === "overlay") return this.createOverlay(options, ownerPid);

    const initialFrame = this.WindowGeometry.initialFrame(options);
    const initialConstraints = this.WindowGeometry.initialConstraints(options);

    const elements = this.WindowChrome.buildWindowChrome(windowHTML);

    const record: WindowRecord = {
      id: this.nextWindowId++ as WindowId,
      ownerPid: ownerPid as Pid,
      kind: "window",
      hidden: false,
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
    this.WindowChrome.applyAppearance(record, options);
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
    if (windowRecord.kind === "overlay") {
      windowRecord.root.setAttribute("aria-label", title);
      return;
    }

    this.events.emit({
      type: "window.titleChanged",
      pid: windowRecord.ownerPid,
      windowId: windowRecord.id,
      title: title,
    });
  }

  public setAppearance(windowId: WindowId, options: WindowOptions): void {
    this.WindowChrome.applyAppearance(this.getWindowRecord(windowId), options);
  }

  public moveWindow(windowId: WindowId, x: number, y: number): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state !== "normal") return;

    // prevent frame from going y negative (off the top of the screen)
    if (y < 0) y = 0;

    windowRecord.frame.x = x;
    windowRecord.frame.y = y;

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  public resizeWindow(windowId: WindowId, frame: Rect): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.state !== "normal") return;

    windowRecord.frame = this.WindowGeometry.clampToConstraints(
      frame,
      windowRecord.constraints,
    );

    this.WindowChrome.applyFrameToWindow(windowRecord);
  }

  /** Change only the size, keeping the position (clamped like any resize). */
  public resizeTo(windowId: WindowId, width: number, height: number): void {
    const record = this.getWindowRecord(windowId);
    if (record.kind === "overlay") {
      this.overlaySizes.set(windowId, { width, height });
      this.placeOverlay(record);
      return;
    }
    this.resizeWindow(windowId, { ...record.frame, width, height });
  }

  /** Where the window is; for an overlay, at the size its app asked for (the screen may squeeze it). */
  public frameOf(windowId: WindowId): Rect {
    return { ...this.getWindowRecord(windowId).frame, ...this.overlaySizes.get(windowId) };
  }

  /**
   * Show or hide an overlay. Shown, it takes the keyboard; hidden, the
   * keyboard goes back to the focused window, which never changed meanwhile.
   */
  public setVisible(windowId: WindowId, visible: boolean): void {
    const record = this.getWindowRecord(windowId);
    if (record.kind !== "overlay") {
      throw kernelError("EINVAL", `Window ${windowId} is not an overlay (minimize it instead)`);
    }
    if (record.hidden === !visible) return;
    record.hidden = !visible;
    const frame = record.bodyEl.querySelector("iframe");

    if (visible) {
      this.placeOverlay(record);
      record.zIndex = ++this.zCounter;
      record.root.style.zIndex = String(record.zIndex);
      record.root.classList.remove("overlay-hidden");
      frame?.focus();
      return;
    }

    record.root.classList.add("overlay-hidden");
    if (frame && document.activeElement === frame) frame.blur();
    const active = this.focusedId === null ? undefined : this.windows.get(this.focusedId);
    if (active) this.focusContent(active);
  }

  public setWindowState(
    windowId: WindowId,
    state: "normal" | "maximized",
  ): void {
    const windowRecord = this.getWindowRecord(windowId);
    if (windowRecord.kind === "overlay") return;
    // Phones have no floating windows: the title-bar double-click can't restore.
    if (state === "normal" && isPhone()) return;
    windowRecord.restoreFrame ??= { ...windowRecord.frame };

    const before = windowRecord.state;

    if (state === "normal") {
      windowRecord.state = "normal";
      windowRecord.frame = { ...windowRecord.restoreFrame };
      windowRecord.restoreFrame = undefined;
    } else if (state === "maximized") {
      windowRecord.frame = this.maximizedFrame();
      windowRecord.state = "maximized";
    }
    windowRecord.tile = undefined;

    this.WindowChrome.applyFrameToWindow(windowRecord);
    this.WindowChrome.applyStateToWindow(
      windowRecord,
      this.focusedId === windowId,
    );
    if (before !== windowRecord.state) this.emitState(windowRecord);
  }

  /**
   * Snap a window into a tile of the work area. false if the window's
   * minimum size doesn't fit there (or on a phone, where every window is full).
   */
  public tileWindow(windowId: WindowId, zone: TileZone): boolean {
    const record = this.getWindowRecord(windowId);
    if (isPhone() || record.kind === "overlay") return false;
    const split = this.splitFor(record);
    const frame = tileFrame(zone, this.workArea.get(), split);
    if (!this.fits(record, frame)) return false;

    this.split = split;
    if (record.state === "normal") record.restoreFrame = { ...record.frame };
    const changed = record.state !== "tiled" || record.tile !== zone;
    record.state = "tiled";
    record.tile = zone;
    record.frame = frame;

    this.WindowChrome.applyFrameToWindow(record);
    this.WindowChrome.applyStateToWindow(record, this.focusedId === windowId);
    if (changed) this.emitState(record);
    return true;
  }

  /** Tile, maximize or restore: `windows.tile`. Throws EINVAL where the window can't go. */
  public arrange(windowId: WindowId, target: SnapTarget | "restore"): void {
    const record = this.getWindowRecord(windowId);
    if (record.kind === "overlay") {
      throw kernelError("EINVAL", `Window ${windowId} is an overlay: it can't be arranged`);
    }
    if (target === "restore") {
      if (record.state !== "normal") this.setWindowState(windowId, "normal");
    } else if (target === "maximize") {
      this.setWindowState(windowId, "maximized");
    } else if (!this.tileWindow(windowId, target)) {
      throw kernelError("EINVAL", `Window ${windowId} doesn't fit the ${target} tile`);
    }
  }

  /** Ctrl+Alt+Arrow on a window: see snap.ts keyStep. */
  public keyTile(windowId: WindowId, arrow: Arrow): void {
    if (isPhone()) return;
    const record = this.getWindowRecord(windowId);
    if (record.kind === "overlay") return;
    const current =
      record.state === "tiled" && record.tile
        ? record.tile
        : record.state === "maximized"
          ? "maximize"
          : "normal";
    const next = keyStep(current, arrow);
    if (next === null) return;
    if (next === "minimize") this.setMinimized(windowId, true);
    else if (next === "normal") this.setWindowState(windowId, "normal");
    else if (next === "maximize") this.setWindowState(windowId, "maximized");
    else this.tileWindow(windowId, next);
  }

  public setMinimized(windowId: WindowId, minimized: boolean): void {
    const record = this.getWindowRecord(windowId);
    if (record.kind === "overlay") {
      throw kernelError("EINVAL", `Window ${windowId} is an overlay (hide it instead)`);
    }
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
    this.layouts.close(windowId);
    if (this.previewOwner === windowId) this.showPreview(record, null);

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
    this.overlaySizes.delete(windowId);
    if (record.kind === "overlay") {
      // Gone while shown: the keyboard goes back where it was.
      const active = this.focusedId === null ? undefined : this.windows.get(this.focusedId);
      if (!record.hidden && active) this.focusContent(active);
      return;
    }

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
    // An overlay is never the focused window: it lies over whichever one is.
    if (record.kind === "overlay") return;
    const previousId = this.focusedId;
    // Another window coming forward (a click, a launch, windows.focus) puts overlays away.
    this.hideOverlays();

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
    // Ctrl+W over an overlay dismisses it; its app keeps running for next time.
    if (record.kind === "overlay") return this.setVisible(windowId, false);

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

  /** Windows only: overlays aren't windows to the shell (no taskbar button). */
  public listWindows(): WindowInfo[] {
    return Array.from(this.windows.values())
      .filter((record) => record.kind === "window")
      .map((record) => ({
      windowId: record.id,
      pid: record.ownerPid,
      title: record.titleEl.textContent || "",
      minimized: record.minimized,
      state: record.state,
      tile: record.tile,
      frame: { ...record.frame },
      focused: this.focusedId === record.id,
    }));
  }

  /** The work area changed: maximized and tiled windows follow it. */
  public reflowLayout(): void {
    const phone = isPhone();
    for (const record of this.windows.values()) {
      if (record.kind === "overlay") {
        this.placeOverlay(record);
        continue;
      }
      // Shrinking into phone mode (rotation, narrow browser) maximizes floating and tiled windows too.
      if (phone && record.state !== "maximized") {
        this.setWindowState(record.id, "maximized");
        continue;
      }
      if (record.state !== "maximized") continue;
      record.frame = this.maximizedFrame();
      this.WindowChrome.applyFrameToWindow(record);
    }
    this.reflowTiles();
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

  private emitState(record: WindowRecord): void {
    this.layouts.close(record.id);
    this.events.emit({
      type: "window.stateChanged",
      pid: record.ownerPid,
      windowId: record.id,
      state: record.state,
      tile: record.tile,
      frame: { ...record.frame },
    });
  }

  private tiledRecords(except?: WindowRecord): WindowRecord[] {
    return [...this.windows.values()].filter(
      (record) => record.state === "tiled" && record !== except,
    );
  }

  /** The split a window tiling now would use: the current one, or even if it's the first tile. */
  private splitFor(record: WindowRecord): Split {
    return this.tiledRecords(record).length > 0
      ? { ...this.split }
      : { ...EVEN_SPLIT };
  }

  private fits(record: WindowRecord, frame: Rect): boolean {
    return (
      frame.width >= record.constraints.minWidth &&
      frame.height >= record.constraints.minHeight
    );
  }

  /** Re-place every tile on the current split and work area. */
  private reflowTiles(): void {
    const area = this.workArea.get();
    for (const record of this.tiledRecords()) {
      if (!record.tile) continue;
      record.frame = tileFrame(record.tile, area, this.split);
      this.WindowChrome.applyFrameToWindow(record);
    }
  }

  /** Where a snap target would put this window, or null if it can't go there. */
  private targetFrame(record: WindowRecord, target: SnapTarget): Rect | null {
    if (target === "maximize") return this.maximizedFrame();
    const frame = tileFrame(target, this.workArea.get(), this.splitFor(record));
    return this.fits(record, frame) ? frame : null;
  }

  /**
   * The translucent outline of where a drag (or a layouts cell) would put
   * the window. For a drag it is drawn under the window and over the rest: it
   * shares the window's z-index and comes first in the layer, so the window
   * paints on top. `above` puts it over every window instead.
   */
  private showPreview(
    record: WindowRecord,
    target: SnapTarget | null,
    above = false,
  ): void {
    const frame = target ? this.targetFrame(record, target) : null;
    const preview = this.preview;
    if (!frame) {
      preview?.classList.remove("visible");
      this.previewOwner = null;
      return;
    }

    const element = this.preview ?? document.createElement("div");
    if (!this.preview) {
      element.className = "snap-preview";
      element.setAttribute("aria-hidden", "true");
      this.preview = element;
    }
    if (element.parentElement !== this.windowLayer) this.windowLayer.prepend(element);
    element.style.zIndex = String(above ? this.zCounter + 1 : record.zIndex);

    // Grow out of the window itself, not from wherever the last preview was.
    if (!element.classList.contains("visible") || this.previewOwner !== record.id) {
      element.style.transition = "none";
      this.placeElement(element, record.frame);
      void element.offsetWidth;
      element.style.transition = "";
    }
    this.previewOwner = record.id;
    this.placeElement(element, frame);
    element.classList.add("visible");
  }

  private placeElement(element: HTMLElement, frame: Rect): void {
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${frame.width}px`;
    element.style.height = `${frame.height}px`;
  }

  /** A drag leaves a tile or maximize: float at the restore size under the pointer. */
  private unsnapForDrag(record: WindowRecord, pointer: { x: number; y: number }): void {
    if (record.state === "normal" || isPhone()) return;
    const restore = record.restoreFrame ?? record.frame;
    record.frame = unsnapFrame(restore, record.frame, pointer, TITLE_BAR);
    record.state = "normal";
    record.tile = undefined;
    record.restoreFrame = undefined;
    this.WindowChrome.applyFrameToWindow(record);
    this.WindowChrome.applyStateToWindow(record, this.focusedId === record.id);
    this.emitState(record);
  }

  /** A tiled window resized on an outer edge: it floats from here, at the frame it has. */
  private float(record: WindowRecord): void {
    if (record.state !== "tiled") return;
    record.state = "normal";
    record.tile = undefined;
    record.restoreFrame = undefined;
    this.WindowChrome.applyStateToWindow(record, this.focusedId === record.id);
    this.emitState(record);
  }

  /** Double-click on an edge of a floating window: that edge goes to the work area's. */
  private stretch(record: WindowRecord, edges: ReadonlySet<Edge>): void {
    if (record.state !== "normal") return;
    const frame = stretchFrame(
      record.frame,
      edges,
      this.workArea.get(),
      record.constraints,
      BORDER,
    );
    this.resizeWindow(record.id, frame);
  }

  private beginSplitResize(record: WindowRecord, edges: ReadonlySet<Edge>): boolean {
    this.splitDrag = undefined;
    if (record.state !== "tiled" || !record.tile || edges.size === 0) return false;
    const inner = innerEdges(record.tile);
    if (![...edges].every((edge) => inner.has(edge))) return false;
    this.splitDrag = { edges, start: { ...this.split } };
    return true;
  }

  private moveSplit(dx: number, dy: number): void {
    if (!this.splitDrag) return;
    const { edges, start } = this.splitDrag;
    const area = this.workArea.get();
    const tiles = this.tiledRecords().flatMap((record) =>
      record.tile ? [{ zone: record.tile, ...record.constraints }] : [],
    );
    const next = { ...this.split };
    const clamp = (value: number, { min, max }: { min: number; max: number }) =>
      min > max ? undefined : Math.min(Math.max(value, min), max);

    if ((edges.has("e") || edges.has("w")) && area.width > 0) {
      next.x = clamp(start.x + dx / area.width, splitBounds("x", tiles, area)) ?? next.x;
    }
    if ((edges.has("n") || edges.has("s")) && area.height > 0) {
      next.y = clamp(start.y + dy / area.height, splitBounds("y", tiles, area)) ?? next.y;
    }
    this.split = next;
    this.reflowTiles();
  }

  /** Fullscreen: maximized windows cover the whole screen (topbar, dock and title bar auto-hide over them). */
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
      if (record.minimized || record.kind === "overlay") continue;
      if (!topmost || record.zIndex > topmost.zIndex) topmost = record;
    }

    if (topmost) {
      this.focusWindow(topmost.id);
    }
  }

  /** An overlay surface: no chrome, hidden until its app shows it (see SurfaceKind). */
  private createOverlay(options: WindowOptions, ownerPid: Pid): WindowRecord {
    const elements = this.WindowChrome.buildWindowChrome(windowHTML);
    const record: WindowRecord = {
      id: this.nextWindowId++ as WindowId,
      ownerPid,
      kind: "overlay",
      hidden: true,
      root: elements.rootElement,
      titleEl: elements.titleElement,
      bodyEl: elements.bodyElement,
      zIndex: 0,
      closeRequestHandlers: [],
      frame: this.WindowGeometry.initialFrame(options),
      constraints: this.WindowGeometry.initialConstraints(options),
      state: "normal",
      minimized: false,
      disposers: [],
    };
    record.root.classList.add("overlay", "overlay-hidden");
    record.root.setAttribute("role", "dialog");
    record.root.setAttribute("aria-label", options.title);
    record.titleEl.textContent = options.title;

    this.windows.set(record.id, record);
    this.overlaySizes.set(record.id, { width: record.frame.width, height: record.frame.height });
    this.overlayLayer.appendChild(record.root);
    this.WindowChrome.applyAppearance(record, options);
    this.placeOverlay(record);
    return record;
  }

  /** Centred, near the top (at the top on phones), at the size its app asked for as far as the screen allows. */
  private placeOverlay(record: WindowRecord): void {
    const want = this.overlaySizes.get(record.id) ?? record.frame;
    const { minWidth, minHeight, maxWidth, maxHeight } = record.constraints;
    const top = isPhone() ? OVERLAY_MARGIN : Math.round(innerHeight * OVERLAY_TOP);
    const fit = (value: number, min: number, max: number, room: number) =>
      Math.round(Math.max(Math.min(min, room), Math.min(value, max, room)));
    const width = fit(want.width, minWidth, maxWidth, innerWidth - 2 * OVERLAY_MARGIN);
    const height = fit(want.height, minHeight, maxHeight, innerHeight - top - OVERLAY_MARGIN);
    record.frame = { x: Math.round((innerWidth - width) / 2), y: top, width, height };
    this.WindowChrome.applyFrameToWindow(record);
  }

  private hideOverlays(): void {
    for (const record of this.windows.values()) {
      if (record.kind === "overlay" && !record.hidden) this.setVisible(record.id, false);
    }
  }

  private createWindowCommands(windowRecord: WindowRecord): WindowCommmands {
    return {
      moveWindow: (x: number, y: number) =>
        this.moveWindow(windowRecord.id, x, y),
      resizeWindow: (frame: Rect) => this.resizeWindow(windowRecord.id, frame),
      setWindowState: (state: "normal" | "maximized") =>
        this.setWindowState(windowRecord.id, state),
      unsnapForDrag: (pointer) => {
        this.layouts.close();
        this.unsnapForDrag(windowRecord, pointer);
      },
      snapTargetAt: (x, y) => {
        if (!this.policy.snap || isPhone()) return null;
        const target = zoneAt(x, y, { width: innerWidth, height: innerHeight });
        return target && this.targetFrame(windowRecord, target) ? target : null;
      },
      previewSnap: (target) => this.showPreview(windowRecord, target),
      snapTo: (target) => {
        if (target === "maximize") this.setWindowState(windowRecord.id, "maximized");
        else this.tileWindow(windowRecord.id, target);
      },
      beginSplitResize: (edges) => this.beginSplitResize(windowRecord, edges),
      moveSplit: (dx, dy) => this.moveSplit(dx, dy),
      float: () => this.float(windowRecord),
      stretch: (edges) => this.stretch(windowRecord, edges),
      hoverLayouts: (button, over) => {
        if (!isPhone()) this.layouts.hover(windowRecord.id, button, over);
      },
      closeLayouts: () => this.layouts.close(windowRecord.id),
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
