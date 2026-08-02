import { rectFromPoints } from "../grid";
import type { DesktopCommands } from "../types";

const MARQUEE_THRESHOLD = 4;

export function enableMarquee(
  surface: HTMLElement,
  marquee: HTMLElement,
  commands: DesktopCommands,
): () => void {
  let activePointer: number | null = null;
  let originX = 0;
  let originY = 0;
  let active = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || activePointer !== null) return;
    // Only start on empty desktop; icons stop propagation themselves.
    if (event.target !== surface) return;

    const bounds = surface.getBoundingClientRect();
    originX = event.clientX - bounds.left;
    originY = event.clientY - bounds.top;
    activePointer = event.pointerId;
    active = false;

    commands.closeMenu();
    if (!event.shiftKey) commands.clearSelection();
    surface.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return;

    const bounds = surface.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;

    if (!active) {
      if (
        Math.abs(x - originX) < MARQUEE_THRESHOLD &&
        Math.abs(y - originY) < MARQUEE_THRESHOLD
      ) {
        return;
      }
      active = true;
      marquee.hidden = false;
    }

    const area = rectFromPoints(originX, originY, x, y);
    marquee.style.transform = `translate(${area.x}px, ${area.y}px)`;
    marquee.style.width = `${area.width}px`;
    marquee.style.height = `${area.height}px`;

    commands.selectWithin(area);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return;
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    activePointer = null;
    active = false;
    marquee.hidden = true;
  };

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", onPointerEnd);
  surface.addEventListener("pointercancel", onPointerEnd);

  return () => {
    surface.removeEventListener("pointerdown", onPointerDown);
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerup", onPointerEnd);
    surface.removeEventListener("pointercancel", onPointerEnd);
  };
}
