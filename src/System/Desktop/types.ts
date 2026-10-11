import type { Rect } from "../../kernel/types";

export interface Cell {
  column: number;
  row: number;
}

/** One entry of ~/Desktop, as the desktop shows it. */
export interface DesktopItem {
  /** File name: the key for the layout and for syncing with the folder. */
  name: string;
  path: string;
  label: string;
  /** Program a `.app` shortcut runs. */
  exec?: string;
  directory: boolean;
  /** An <img> src, or else inline SVG markup. */
  image?: string;
  svg?: string;
}

export interface DesktopIcon {
  readonly item: DesktopItem;
  readonly element: HTMLElement;
  x: number;
  y: number;
  selected: boolean;
}

export interface Point {
  x: number;
  y: number;
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
  /** `pointer` (client coordinates) is where the drag is: over the Bin, it lights up. */
  moveTo(positions: readonly IconPosition[], pointer?: Point): void;
  /** Dropped on the Bin: the icons' files go there instead of to a cell. */
  commitMove(icons: readonly DesktopIcon[], pointer?: Point): void;
  trashSelection(): void;
  launch(icon: DesktopIcon): void;
  activateSelection(): void;
  moveFocus(
    direction: "up" | "down" | "left" | "right",
    additive: boolean,
  ): void;
  openMenu(x: number, y: number, icon: DesktopIcon | null): void;
  closeMenu(): void;
}
