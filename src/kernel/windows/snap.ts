// Window snapping geometry: pure functions, no DOM, so snap.check.ts can run them in node.
import type { Rect } from "../types";

export type TileZone =
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Where a drag, a key or `windows.tile` can put a window. */
export type SnapTarget = TileZone | "maximize";

export const TILE_ZONES: readonly TileZone[] = [
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export const isTileZone = (value: unknown): value is TileZone =>
  TILE_ZONES.includes(value as TileZone);

/** Where the shared edges sit, as fractions of the work area. One per axis for the whole screen. */
export interface Split {
  x: number;
  y: number;
}

export const EVEN_SPLIT: Readonly<Split> = { x: 0.5, y: 0.5 };

export type Edge = "n" | "s" | "e" | "w";
export type Arrow = "left" | "right" | "up" | "down";

export const isArrow = (value: unknown): value is Arrow =>
  value === "left" || value === "right" || value === "up" || value === "down";

/** How close (px) the pointer must get to a screen edge. The pointer can't leave the page, so this is the whole target. */
const EDGE = 6;
/** A corner is this share of the edge it lies on, at most CORNER_MAX px. */
const CORNER_SHARE = 0.15;
const CORNER_MAX = 120;
/** No split puts a shared edge closer than this to the screen edge. */
const SPLIT_MIN = 0.15;

/**
 * The snap target under the pointer during a drag, or null. The middle of the
 * bottom edge is the dock's, so only its corners snap.
 */
export function zoneAt(
  x: number,
  y: number,
  screen: { width: number; height: number },
): SnapTarget | null {
  const { width, height } = screen;
  const cornerX = Math.min(CORNER_MAX, width * CORNER_SHARE);
  const cornerY = Math.min(CORNER_MAX, height * CORNER_SHARE);
  const atLeft = x <= EDGE;
  const atRight = x >= width - 1 - EDGE;
  const atTop = y <= EDGE;
  const atBottom = y >= height - 1 - EDGE;

  const nearLeft = x < cornerX;
  const nearRight = x > width - cornerX;
  const nearTop = y < cornerY;
  const nearBottom = y > height - cornerY;

  if ((atTop && nearLeft) || (atLeft && nearTop)) return "top-left";
  if ((atTop && nearRight) || (atRight && nearTop)) return "top-right";
  if ((atBottom && nearLeft) || (atLeft && nearBottom)) return "bottom-left";
  if ((atBottom && nearRight) || (atRight && nearBottom)) return "bottom-right";
  if (atTop) return "maximize";
  if (atLeft) return "left";
  if (atRight) return "right";
  return null;
}

/** The frame of a tile. Neighbours share their edge exactly (both derive it from the same rounding). */
export function tileFrame(zone: TileZone, area: Rect, split: Split): Rect {
  const leftWidth = Math.round(area.width * split.x);
  const topHeight = Math.round(area.height * split.y);
  const onLeft = zone === "left" || zone.endsWith("-left");
  const x = onLeft ? area.x : area.x + leftWidth;
  const width = onLeft ? leftWidth : area.width - leftWidth;

  if (zone === "left" || zone === "right") {
    return { x, y: area.y, width, height: area.height };
  }
  const onTop = zone.startsWith("top-");
  return {
    x,
    y: onTop ? area.y : area.y + topHeight,
    width,
    height: onTop ? topHeight : area.height - topHeight,
  };
}

/** The edges of a tile that face another tile rather than the screen edge. */
export function innerEdges(zone: TileZone): Set<Edge> {
  const edges = new Set<Edge>();
  edges.add(zone === "left" || zone.endsWith("-left") ? "e" : "w");
  if (zone.startsWith("top-")) edges.add("s");
  if (zone.startsWith("bottom-")) edges.add("n");
  return edges;
}

/** Which split a tile's position depends on. */
export const usesSplitY = (zone: TileZone): boolean =>
  zone !== "left" && zone !== "right";

export const isLeftSide = (zone: TileZone): boolean =>
  zone === "left" || zone.endsWith("-left");

export const isTopSide = (zone: TileZone): boolean => zone.startsWith("top-");

/**
 * The range a split may move in so that every tile keeps its window's
 * minimum size. `tiles` are the windows tiled now, with their minimums.
 */
export function splitBounds(
  axis: "x" | "y",
  tiles: ReadonlyArray<{ zone: TileZone; minWidth: number; minHeight: number }>,
  area: Rect,
): { min: number; max: number } {
  let min = SPLIT_MIN;
  let max = 1 - SPLIT_MIN;
  const size = axis === "x" ? area.width : area.height;
  if (size <= 0) return { min: 0.5, max: 0.5 };

  for (const tile of tiles) {
    if (axis === "y" && !usesSplitY(tile.zone)) continue;
    const need = (axis === "x" ? tile.minWidth : tile.minHeight) / size;
    const first = axis === "x" ? isLeftSide(tile.zone) : isTopSide(tile.zone);
    if (first) min = Math.max(min, need);
    else max = Math.min(max, 1 - need);
  }
  return { min, max };
}

/**
 * Where a snapped window lands when dragged out of its tile: back at its
 * floating size, under the pointer at the same share of its width, and grabbed
 * inside the title bar.
 */
export function unsnapFrame(
  restore: Rect,
  current: Rect,
  pointer: { x: number; y: number },
  titleBarHeight: number,
): Rect {
  const share =
    current.width > 0 ? (pointer.x - current.x) / current.width : 0.5;
  const grabX = Math.round(
    Math.min(Math.max(share, 0), 1) * restore.width,
  );
  const grabY = Math.min(
    Math.max(pointer.y - current.y, 0),
    titleBarHeight / 2,
  );
  return {
    x: pointer.x - grabX,
    y: Math.max(0, pointer.y - grabY),
    width: restore.width,
    height: restore.height,
  };
}

/**
 * Ctrl+Alt+Arrow. Like Windows' Win+Arrow: halves from anywhere, then up or
 * down for the quarters; back the way you came restores; down off the bottom
 * minimizes. null: the key does nothing here.
 */
export function keyStep(
  current: SnapTarget | "normal",
  arrow: Arrow,
): SnapTarget | "normal" | "minimize" | null {
  const steps: Record<SnapTarget | "normal", Partial<Record<Arrow, SnapTarget | "normal" | "minimize">>> = {
    normal: { left: "left", right: "right", up: "maximize", down: "minimize" },
    maximize: { left: "left", right: "right", down: "normal" },
    left: { right: "normal", up: "top-left", down: "bottom-left" },
    right: { left: "normal", up: "top-right", down: "bottom-right" },
    "top-left": { right: "top-right", up: "maximize", down: "left" },
    "top-right": { left: "top-left", up: "maximize", down: "right" },
    "bottom-left": { right: "bottom-right", up: "left", down: "minimize" },
    "bottom-right": { left: "bottom-left", up: "right", down: "minimize" },
  };
  return steps[current][arrow] ?? null;
}

/** The half beside a half; quarters have no single opposite. */
export function oppositeHalf(zone: TileZone): TileZone | null {
  if (zone === "left") return "right";
  if (zone === "right") return "left";
  return null;
}
