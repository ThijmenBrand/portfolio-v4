import { selectElementFromTemplate } from "../../../utils/html";
import type { WindowCommmands, WindowRecord } from "../types";

export function enableResize(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  const seResizeHandle = selectElementFromTemplate<HTMLElement>(
    record.root,
    "#se-resize-handle",
  );
  const eResizeHandle = selectElementFromTemplate<HTMLElement>(
    record.root,
    "#e-resize-handle",
  );
  const sResizeHandle = selectElementFromTemplate<HTMLElement>(
    record.root,
    "#s-resize-handle",
  );

  let isResizing = false;
  let initialMouseX = 0;
  let initialMouseY = 0;
  let initialWidth = 0;
  let initialHeight = 0;

  const startResize = (event: MouseEvent, direction: "se" | "e" | "s") => {
    isResizing = true;
    initialMouseX = event.clientX;
    initialMouseY = event.clientY;
    initialWidth = record.frame.width;
    initialHeight = record.frame.height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing) return;

      const deltaX = moveEvent.clientX - initialMouseX;
      const deltaY = moveEvent.clientY - initialMouseY;

      if (direction === "se") {
        commands.resizeWindow({
          ...record.frame,
          width: Math.max(
            record.constraints.minWidth,
            Math.min(initialWidth + deltaX, record.constraints.maxWidth),
          ),
          height: Math.max(
            record.constraints.minHeight,
            Math.min(initialHeight + deltaY, record.constraints.maxHeight),
          ),
        });
      } else if (direction === "e") {
        commands.resizeWindow({
          ...record.frame,
          width: Math.max(
            record.constraints.minWidth,
            Math.min(initialWidth + deltaX, record.constraints.maxWidth),
          ),
        });
      } else if (direction === "s") {
        commands.resizeWindow({
          ...record.frame,
          height: Math.max(
            record.constraints.minHeight,
            Math.min(initialHeight + deltaY, record.constraints.maxHeight),
          ),
        });
      }
    };

    const onMouseUp = () => {
      isResizing = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const seResizeHandler = (event: MouseEvent) => startResize(event, "se");
  const eResizeHandler = (event: MouseEvent) => startResize(event, "e");
  const sResizeHandler = (event: MouseEvent) => startResize(event, "s");

  seResizeHandle.addEventListener("mousedown", seResizeHandler);
  eResizeHandle.addEventListener("mousedown", eResizeHandler);
  sResizeHandle.addEventListener("mousedown", sResizeHandler);

  return () => {
    seResizeHandle.removeEventListener("mousedown", seResizeHandler);
    eResizeHandle.removeEventListener("mousedown", eResizeHandler);
    sResizeHandle.removeEventListener("mousedown", sResizeHandler);
  };
}
