import { selectElementFromTemplate } from "../../../utils/html";
import type { WindowCommmands, WindowRecord } from "../types";

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
    isDragging = true;
    offsetX = event.clientX - record.frame.x;
    offsetY = event.clientY - record.frame.y;
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (isDragging) {
      commands.moveWindow(event.clientX - offsetX, event.clientY - offsetY);
    }
  };

  const handleMouseUp = () => {
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
