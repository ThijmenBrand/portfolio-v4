import { setDragging } from "../icon";
import type { DesktopCommands, DesktopIcon, IconPosition } from "../types";

const DRAG_THRESHOLD = 4;

export function enableDrag(
  icon: DesktopIcon,
  commands: DesktopCommands,
): () => void {
  let activePointer: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let origins: IconPosition[] = [];

  const onPointerDown = (event: PointerEvent): void => {
    // Ignore secondary touches outright — a second finger must not hijack a
    // drag already in flight.
    if (event.button !== 0 || activePointer !== null) return;
    event.stopPropagation();

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      commands.toggleSelect(icon);
    } else if (!icon.selected) {
      commands.selectOnly(icon);
    }

    activePointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;
    icon.element.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragging) {
      // Below the threshold this is still a click. Without it, a one-pixel
      // wobble between the halves of a double click nudges the icon.
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
        return;
      }
      dragging = true;
      // Snapshot once. The selection must not change mid-drag, and positions
      // are always recomputed from the origin plus the TOTAL delta rather than
      // accumulated per move — same rule as window resize.
      origins = commands
        .selectedIcons()
        .map((target) => ({ icon: target, x: target.x, y: target.y }));
      for (const origin of origins) setDragging(origin.icon, true);
    }

    commands.moveTo(
      origins.map((origin) => ({
        icon: origin.icon,
        x: origin.x + dx,
        y: origin.y + dy,
      })),
    );
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return;
    if (icon.element.hasPointerCapture(event.pointerId)) {
      icon.element.releasePointerCapture(event.pointerId);
    }
    activePointer = null;

    if (!dragging) return;
    dragging = false;
    for (const origin of origins) setDragging(origin.icon, false);
    commands.commitMove(origins.map((origin) => origin.icon));
    origins = [];
  };

  const onDoubleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    commands.launch(icon);
  };

  icon.element.addEventListener("pointerdown", onPointerDown);
  icon.element.addEventListener("pointermove", onPointerMove);
  icon.element.addEventListener("pointerup", onPointerEnd);
  icon.element.addEventListener("pointercancel", onPointerEnd);
  icon.element.addEventListener("dblclick", onDoubleClick);

  return () => {
    icon.element.removeEventListener("pointerdown", onPointerDown);
    icon.element.removeEventListener("pointermove", onPointerMove);
    icon.element.removeEventListener("pointerup", onPointerEnd);
    icon.element.removeEventListener("pointercancel", onPointerEnd);
    icon.element.removeEventListener("dblclick", onDoubleClick);
  };
}
