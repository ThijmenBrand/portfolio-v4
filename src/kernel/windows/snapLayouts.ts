import layoutsHTML from "./gui/layouts.html?raw";
import { htmlStringToTemplate } from "../../utils/html";
import type { WindowId } from "../types";
import { isTileZone, type TileZone } from "./snap";

/** Hover this long on a maximize button before the layouts open. */
const OPEN_MS = 450;
/** Grace for the pointer to cross from the button to the picker. */
const CLOSE_MS = 250;

export interface SnapLayoutsHost {
  /** Raise the picker over every window. */
  topZ(): number;
  /** Hovering a cell previews it on screen; null clears. */
  preview(windowId: WindowId, zone: TileZone | null): void;
  pick(windowId: WindowId, zone: TileZone): void;
}

/**
 * The layouts picker under a maximize button (like Windows 11's snap
 * layouts). One shared element in the window layer: the window's own root
 * clips its overflow, so the picker can't live inside it.
 */
export class SnapLayouts {
  private readonly layer: HTMLElement;
  private readonly host: SnapLayoutsHost;
  private element: HTMLElement | undefined;
  private owner: WindowId | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(layer: HTMLElement, host: SnapLayoutsHost) {
    this.layer = layer;
    this.host = host;
  }

  /** The pointer entered (over) or left a window's maximize button. */
  public hover(windowId: WindowId, button: HTMLElement, over: boolean): void {
    clearTimeout(this.timer);
    if (!over) {
      this.timer = setTimeout(() => this.close(), CLOSE_MS);
      return;
    }
    if (this.owner === windowId) return;
    this.timer = setTimeout(() => this.open(windowId, button), OPEN_MS);
  }

  /** Closes the picker; with a window id, only if it is that window's. */
  public close(windowId?: WindowId): void {
    if (windowId !== undefined && this.owner !== windowId) return;
    clearTimeout(this.timer);
    if (this.owner !== null) this.host.preview(this.owner, null);
    this.owner = null;
    this.element?.remove();
  }

  private open(windowId: WindowId, button: HTMLElement): void {
    if (!button.isConnected) return;
    const element = (this.element ??= this.build());
    this.owner = windowId;
    element.style.zIndex = String(this.host.topZ());
    this.layer.append(element);

    // Under the button, left edges aligned, kept on screen.
    const anchor = button.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(4, Math.min(anchor.left, innerWidth - width - 4));
    const below = anchor.bottom + 4;
    const top = below + height > innerHeight ? anchor.top - height - 4 : below;
    element.style.left = `${left}px`;
    element.style.top = `${Math.max(4, top)}px`;
  }

  private build(): HTMLElement {
    const element = htmlStringToTemplate(layoutsHTML);
    element.addEventListener("mouseenter", () => clearTimeout(this.timer));
    element.addEventListener("mouseleave", () => {
      if (this.owner !== null) this.host.preview(this.owner, null);
      this.timer = setTimeout(() => this.close(), CLOSE_MS);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });

    for (const cell of element.querySelectorAll<HTMLElement>(".snap-cell")) {
      const zone = cell.dataset.zone;
      if (!isTileZone(zone)) continue;
      const show = (on: boolean) => {
        if (this.owner !== null) this.host.preview(this.owner, on ? zone : null);
      };
      cell.addEventListener("mouseenter", () => show(true));
      cell.addEventListener("mouseleave", () => show(false));
      cell.addEventListener("focus", () => show(true));
      cell.addEventListener("blur", () => show(false));
      cell.addEventListener("click", () => {
        const owner = this.owner;
        this.close();
        if (owner !== null) this.host.pick(owner, zone);
      });
    }
    return element;
  }
}
