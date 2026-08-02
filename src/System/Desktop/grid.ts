import type { Rect } from "../../kernel/types";
import type { Cell } from "./types";

export const GRID = {
  cellWidth: 96,
  cellHeight: 104,
  iconWidth: 88,
  iconHeight: 96,
  originX: 12,
  originY: 12,
} as const;

export function cellKey(cell: Cell): string {
  return `${cell.column},${cell.row}`;
}

export function cellToPoint(cell: Cell): { x: number; y: number } {
  return {
    x: GRID.originX + cell.column * GRID.cellWidth,
    y: GRID.originY + cell.row * GRID.cellHeight,
  };
}

export function pointToCell(x: number, y: number): Cell {
  return {
    column: Math.max(0, Math.round((x - GRID.originX) / GRID.cellWidth)),
    row: Math.max(0, Math.round((y - GRID.originY) / GRID.cellHeight)),
  };
}

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width - GRID.originX) / GRID.cellWidth));
}

export function rowsFor(height: number): number {
  return Math.max(1, Math.floor((height - GRID.originY) / GRID.cellHeight));
}

/** Column-major, the way desktops fill: down the column, then across. */
export function nextFreeCell(taken: ReadonlySet<string>, rows: number): Cell {
  for (let column = 0; ; column++) {
    for (let row = 0; row < rows; row++) {
      const cell: Cell = { column, row };
      if (!taken.has(cellKey(cell))) return cell;
    }
  }
}

export function clampCell(cell: Cell, columns: number, rows: number): Cell {
  return {
    column: Math.min(Math.max(0, cell.column), columns - 1),
    row: Math.min(Math.max(0, cell.row), rows - 1),
  };
}

export function iconRect(x: number, y: number): Rect {
  return { x, y, width: GRID.iconWidth, height: GRID.iconHeight };
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function rectFromPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}
