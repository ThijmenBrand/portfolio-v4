import type { AppEntry } from "../../apps/registry";
import type { Rect } from "../../kernel/types";

export interface Cell {
  column: number;
  row: number;
}

export interface DesktopIcon {
  readonly entry: AppEntry;
  readonly element: HTMLElement;
  x: number;
  y: number;
  selected: boolean;
}

export interface IconPosition {
  icon: DesktopIcon;
  x: number;
  y: number;
}

/**
 * The narrow capability the interaction adapters receive. They never touch the
 * icon list, the layout or the selection set directly — same discipline as
 * WindowCommands in the window manager.
 */
export interface DesktopCommands {
  selectOnly(icon: DesktopIcon): void;
  toggleSelect(icon: DesktopIcon): void;
  clearSelection(): void;
  selectWithin(area: Rect): void;
  selectedIcons(): DesktopIcon[];
  moveTo(positions: readonly IconPosition[]): void;
  commitMove(icons: readonly DesktopIcon[]): void;
  launch(icon: DesktopIcon): void;
  activateSelection(): void;
  moveFocus(
    direction: "up" | "down" | "left" | "right",
    additive: boolean,
  ): void;
  openMenu(x: number, y: number, icon: DesktopIcon | null): void;
  closeMenu(): void;
}
