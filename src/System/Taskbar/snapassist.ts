// Snap assist: after a window snaps to one half, offer the other windows for
// the half left empty (like Windows' Snap Assist, which explorer.exe draws too).
// Shell UI over the kernel's mechanics: it only sees `window.stateChanged`
// and answers with `windows.tile`, like any other program could.
import type { SystemInterface } from "../../kernel/syscalls/api";
import type { EventOf } from "../../kernel/events/types";
import type { Pid, WindowId } from "../../kernel/types";
import { isLeftSide, oppositeHalf, type TileZone } from "../../kernel/windows/snap";
import type { WindowInfo } from "../../kernel/windows/types";
import { logError } from "../../kernel/errors";
import "./snapassist.css";

export interface AppLook {
  name: string;
  icon: string;
}

export class SnapAssist {
  private readonly os: SystemInterface;
  private readonly layer: HTMLElement;
  private readonly look: (pid: Pid) => AppLook;
  private overlay: HTMLElement | undefined;
  /** The window that snapped and opened the offer. */
  private anchor: WindowId | null = null;
  public enabled = true;

  constructor(os: SystemInterface, layer: HTMLElement, look: (pid: Pid) => AppLook) {
    this.os = os;
    this.layer = layer;
    this.look = look;
  }

  public async start(): Promise<void> {
    await this.os.events.subscribe(
      ["window.stateChanged", "window.destroyed"],
      (event) => {
        if (event.type === "window.destroyed") {
          if (event.windowId === this.anchor) this.dismiss();
          return;
        }
        // Anything the anchor does next (drag out, maximize) ends the offer.
        if (event.windowId === this.anchor) this.dismiss();
        if (event.state === "tiled" && event.tile && this.enabled) {
          void this.offer(event, event.tile).catch(logError);
        }
      },
    );

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.overlay) this.dismiss();
    });
  }

  private async offer(
    event: EventOf<"window.stateChanged">,
    tile: TileZone,
  ): Promise<void> {
    const opposite = oppositeHalf(tile);
    if (!opposite) return;

    const windows = await this.os.windows.list();
    const otherSide = isLeftSide(opposite);
    const taken = windows.some(
      (win) =>
        win.state === "tiled" &&
        !win.minimized &&
        win.tile !== undefined &&
        isLeftSide(win.tile) === otherSide,
    );
    const candidates = windows.filter(
      (win) => win.windowId !== event.windowId && win.state !== "tiled",
    );
    if (taken || candidates.length === 0) return;

    // Still the latest snap? Another may have landed while we listed.
    const self = windows.find((win) => win.windowId === event.windowId);
    if (self?.state !== "tiled" || self.tile !== tile) return;

    const area = await this.os.display.workArea();
    const frame = self.frame;
    const left = isLeftSide(tile) ? frame.x + frame.width : area.x;
    this.show(event.windowId, opposite, candidates, {
      x: left,
      y: area.y,
      width: area.width - frame.width,
      height: area.height,
    });
  }

  private show(
    anchor: WindowId,
    zone: TileZone,
    candidates: WindowInfo[],
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    this.dismiss();
    this.anchor = anchor;

    const overlay = document.createElement("div");
    overlay.className = "snap-assist";
    // A click anywhere but a window's card declines, the empty half included.
    overlay.addEventListener("mousedown", (event) => {
      if (!(event.target as Element).closest(".snap-assist-card")) this.dismiss();
    });

    const panel = document.createElement("div");
    panel.className = "snap-assist-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Choose a window for this side");
    panel.style.left = `${rect.x}px`;
    panel.style.top = `${rect.y}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;

    const content = document.createElement("div");
    content.className = "snap-assist-content";

    const hint = document.createElement("p");
    hint.className = "snap-assist-hint";
    hint.textContent = "Choose a window for this side";

    const skip = document.createElement("p");
    skip.className = "snap-assist-skip";
    skip.textContent = "Click anywhere else or press Esc to skip";

    const grid = document.createElement("div");
    grid.className = "snap-assist-grid";
    grid.append(
      ...candidates.map((win, index) => {
        const look = this.look(win.pid);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "snap-assist-card";
        card.style.setProperty("--i", String(index));

        const icon = document.createElement("img");
        icon.className = "snap-assist-icon";
        icon.alt = "";
        icon.src = look.icon;
        const title = document.createElement("span");
        title.className = "snap-assist-title";
        title.textContent = win.title || look.name;
        const app = document.createElement("span");
        app.className = "snap-assist-app";
        app.textContent = [
          title.textContent === look.name ? "" : look.name,
          win.minimized ? "Minimized" : "",
        ]
          .filter(Boolean)
          .join(" · ");

        card.append(icon, title);
        if (app.textContent) card.append(app);
        card.addEventListener("click", () => {
          this.dismiss();
          void this.os.windows
            .tile(win.windowId, zone)
            .then(() => this.os.windows.focus(win.windowId))
            .catch(logError);
        });
        return card;
      }),
    );

    content.append(hint, grid, skip);
    panel.append(content);
    overlay.append(panel);
    this.layer.append(overlay);
    this.overlay = overlay;
    grid.querySelector<HTMLElement>(".snap-assist-card")?.focus({ preventScroll: true });
  }

  public dismiss(): void {
    this.overlay?.remove();
    this.overlay = undefined;
    this.anchor = null;
  }
}
