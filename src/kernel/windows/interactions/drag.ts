import { selectElementFromTemplate } from "../../../utils/html";
import { isPhone } from "../../../utils/phone";
import type { SnapTarget } from "../snap";
import type { WindowCommmands, WindowRecord } from "../types";
import { shieldIframes, unshieldIframes } from "./shield";

/** The pointer must travel this far (px) before a press becomes a drag, so double-clicks stay double-clicks. */
const DRAG_THRESHOLD = 4;

export function enableDrag(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  let pressed = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;
  let target: SnapTarget | null = null;

  const topBarElement = selectElementFromTemplate<HTMLElement>(
    record.root,
    "#window-top-bar",
  );

  const handleMouseDown = (event: MouseEvent) => {
    // A press on a title-bar button is a click, not the start of a drag.
    if ((event.target as Element).closest(".window-button")) return;
    if (event.button !== 0 || isPhone()) return;
    pressed = true;
    dragging = false;
    shieldIframes();
    startX = event.clientX;
    startY = event.clientY;
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (!pressed) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      commands.closeLayouts();
      // Out of a tile or maximize: back to the floating size, under the pointer.
      if (record.state !== "normal") commands.unsnapForDrag({ x: startX, y: startY });
      offsetX = startX - record.frame.x;
      offsetY = startY - record.frame.y;
    }
    commands.moveWindow(event.clientX - offsetX, event.clientY - offsetY);

    const next = commands.snapTargetAt(event.clientX, event.clientY);
    if (next !== target) {
      target = next;
      commands.previewSnap(target);
    }
  };

  const handleMouseUp = () => {
    if (!pressed) return;
    unshieldIframes();
    if (dragging && target) {
      commands.previewSnap(null);
      commands.snapTo(target);
    }
    pressed = false;
    dragging = false;
    target = null;
  };

  topBarElement.addEventListener("mousedown", handleMouseDown);
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);

  return () => {
    if (pressed) unshieldIframes();
    topBarElement.removeEventListener("mousedown", handleMouseDown);
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  };
}
