import type { Edge } from "../snap";
import type { WindowCommmands, WindowRecord } from "../types";
import { shieldIframes, unshieldIframes } from "./shield";

const DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Direction = (typeof DIRECTIONS)[number];

/**
 * Resize from any edge or corner. On a tiled window, an edge it shares with
 * other tiles moves the split (every tile follows); any other edge lets the
 * window float first.
 */
export function enableResize(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  const startResize = (event: MouseEvent, direction: Direction) => {
    if (event.button !== 0) return;
    event.preventDefault();
    commands.closeLayouts();

    const edges = new Set(direction.split("") as Edge[]);
    const splitting = commands.beginSplitResize(edges);
    if (!splitting) commands.float();

    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...record.frame };
    const { minWidth, maxWidth, minHeight, maxHeight } = record.constraints;
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(value, max));

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (splitting) return commands.moveSplit(dx, dy);

      const frame = { ...start };
      if (edges.has("e")) frame.width = clamp(start.width + dx, minWidth, maxWidth);
      if (edges.has("w")) {
        frame.width = clamp(start.width - dx, minWidth, maxWidth);
        frame.x = start.x + start.width - frame.width;
      }
      if (edges.has("s")) frame.height = clamp(start.height + dy, minHeight, maxHeight);
      if (edges.has("n")) {
        // The title bar must stay reachable: the top edge stops at the screen's.
        const bottom = start.y + start.height;
        frame.height = clamp(start.height - dy, minHeight, Math.min(maxHeight, bottom));
        frame.y = bottom - frame.height;
      }
      commands.resizeWindow(frame);
    };

    const onMouseUp = () => {
      unshieldIframes();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    shieldIframes();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handlers = DIRECTIONS.flatMap((direction) => {
    const handle = record.root.querySelector<HTMLElement>(
      `.resize-handle[data-direction="${direction}"]`,
    );
    if (!handle) return [];
    const handler = (event: MouseEvent) => startResize(event, direction);
    handle.addEventListener("mousedown", handler);
    return [() => handle.removeEventListener("mousedown", handler)];
  });

  return () => handlers.forEach((remove) => remove());
}
