// Self-check for snap.ts: `node src/kernel/windows/snap.check.ts` (or `pnpm check`).
import {
  EVEN_SPLIT,
  innerEdges,
  keyStep,
  splitBounds,
  tileFrame,
  unsnapFrame,
  zoneAt,
} from "./snap.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const screen = { width: 1440, height: 900 };

// Edges and corners. Corners are min(120, 15%) along each edge.
eq(zoneAt(700, 0, screen), "maximize", "top middle maximizes");
eq(zoneAt(0, 450, screen), "left", "left edge");
eq(zoneAt(1439, 450, screen), "right", "right edge");
eq(zoneAt(1439 - 6, 450, screen), "right", "right edge threshold");
eq(zoneAt(1439 - 7, 450, screen), null, "just inside the right edge");
eq(zoneAt(50, 0, screen), "top-left", "top edge near the left corner");
eq(zoneAt(0, 50, screen), "top-left", "left edge near the top corner");
eq(zoneAt(1400, 2, screen), "top-right", "top edge near the right corner");
eq(zoneAt(3, 880, screen), "bottom-left", "left edge near the bottom");
eq(zoneAt(1430, 899, screen), "bottom-right", "bottom edge near the right");
eq(zoneAt(700, 899, screen), null, "bottom middle is the dock's");
eq(zoneAt(700, 450, screen), null, "middle of the screen");
eq(zoneAt(119, 0, screen), "top-left", "corner is 120px wide on a wide screen");
eq(zoneAt(121, 0, screen), "maximize", "past the corner");
// A small screen: 15% of 400 = 60.
eq(zoneAt(70, 0, { width: 400, height: 300 }), "maximize", "corner shrinks with the screen");

// Frames tile the work area exactly, around the split.
const area = { x: 0, y: 28, width: 1441, height: 801 };
const left = tileFrame("left", area, EVEN_SPLIT);
const right = tileFrame("right", area, EVEN_SPLIT);
eq(left, { x: 0, y: 28, width: 721, height: 801 }, "left half");
eq(right.x, left.x + left.width, "halves meet");
eq(left.width + right.width, area.width, "halves fill the width");
const tl = tileFrame("top-left", area, EVEN_SPLIT);
const bl = tileFrame("bottom-left", area, EVEN_SPLIT);
eq(bl.y, tl.y + tl.height, "quarters meet");
eq(tl.height + bl.height, area.height, "quarters fill the height");
eq(
  tileFrame("bottom-right", area, { x: 0.25, y: 0.75 }),
  { x: 360, y: 629, width: 1081, height: 200 },
  "uneven split",
);

eq([...innerEdges("left")], ["e"], "left half's shared edge");
eq([...innerEdges("bottom-right")], ["w", "n"], "bottom-right's shared edges");

// Split bounds keep each side's minimum size.
eq(
  splitBounds(
    "x",
    [
      { zone: "left", minWidth: 500, minHeight: 100 },
      { zone: "right", minWidth: 200, minHeight: 100 },
    ],
    { x: 0, y: 0, width: 1000, height: 800 },
  ),
  { min: 0.5, max: 0.8 },
  "x bounds from minimum widths",
);
eq(
  splitBounds(
    "y",
    [{ zone: "left", minWidth: 100, minHeight: 700 }],
    { x: 0, y: 0, width: 1000, height: 800 },
  ),
  { min: 0.15, max: 0.85 },
  "halves don't constrain the y split",
);

// Unsnap keeps the pointer at the same share of the width, inside the bar.
eq(
  unsnapFrame(
    { x: 10, y: 10, width: 400, height: 300 },
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 750, y: 5 },
    34,
  ),
  { x: 450, y: 0, width: 400, height: 300 },
  "unsnap from maximized",
);
eq(
  unsnapFrame(
    { x: 10, y: 10, width: 400, height: 300 },
    { x: 720, y: 28, width: 720, height: 800 },
    { x: 1080, y: 60 },
    34,
  ),
  { x: 880, y: 43, width: 400, height: 300 },
  "unsnap from the right half, grabbed low in the bar",
);

// Keyboard steps.
eq(keyStep("normal", "left"), "left", "normal ← left");
eq(keyStep("left", "up"), "top-left", "left ↑ top-left");
eq(keyStep("top-left", "right"), "top-right", "quarters walk sideways");
eq(keyStep("left", "right"), "normal", "back the way you came restores");
eq(keyStep("maximize", "down"), "normal", "maximized ↓ restores");
eq(keyStep("normal", "down"), "minimize", "normal ↓ minimizes");
eq(keyStep("left", "left"), null, "left ← does nothing");

console.log(`snap.check: ${count} ok`);
