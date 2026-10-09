import type { WindowCommmands, WindowRecord } from "../types";

export function enableFocus(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  const windowElement = record.root;

  const handleFocus = () => {
    commands.focusWindow();
  };

  windowElement.addEventListener("mousedown", handleFocus);

  // A click inside an iframe app never reaches our mousedown listener. What
  // we DO see: the kernel's window loses focus to that iframe. If the newly
  // focused element is an iframe inside this window, raise the window.
  const handleBlur = () => {
    // activeElement is updated after blur fires; check on the next task.
    setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && windowElement.contains(active)) {
        commands.focusWindow();
      }
    }, 0);
  };
  window.addEventListener("blur", handleBlur);

  return () => {
    windowElement.removeEventListener("mousedown", handleFocus);
    window.removeEventListener("blur", handleBlur);
  };
}
