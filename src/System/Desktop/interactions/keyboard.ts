import type { DesktopCommands } from "../types";

export function enableKeyboard(
  surface: HTMLElement,
  commands: DesktopCommands,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowUp":
        commands.moveFocus("up", event.shiftKey);
        break;
      case "ArrowDown":
        commands.moveFocus("down", event.shiftKey);
        break;
      case "ArrowLeft":
        commands.moveFocus("left", event.shiftKey);
        break;
      case "ArrowRight":
        commands.moveFocus("right", event.shiftKey);
        break;
      case "Enter":
        commands.activateSelection();
        break;
      case "Escape":
        commands.closeMenu();
        commands.clearSelection();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  surface.addEventListener("keydown", onKeyDown);
  return () => surface.removeEventListener("keydown", onKeyDown);
}
