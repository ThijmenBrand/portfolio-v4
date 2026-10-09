import { selectElementFromTemplate } from "../../../utils/html";
import type { WindowCommmands, WindowRecord } from "../types";
import { shieldIframes, unshieldIframes } from "./shield";

export function enableDrag(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const topBarElement = selectElementFromTemplate<HTMLElement>(
    record.root,
    "#window-top-bar",
  );

  const handleMouseDown = (event: MouseEvent) => {
    // A press on a title-bar button is a click, not the start of a drag.
    if ((event.target as Element).closest(".window-button")) return;
    if (event.button !== 0) return;
    isDragging = true;
    shieldIframes();
    offsetX = event.clientX - record.frame.x;
    offsetY = event.clientY - record.frame.y;
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (isDragging) {
      commands.moveWindow(event.clientX - offsetX, event.clientY - offsetY);
    }
  };

  const handleMouseUp = () => {
    if (isDragging) unshieldIframes();
    isDragging = false;
  };

  topBarElement.addEventListener("mousedown", handleMouseDown);
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);

  return () => {
    topBarElement.removeEventListener("mousedown", handleMouseDown);
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  };
}
