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

  return () => {
    windowElement.removeEventListener("mousedown", handleFocus);
  };
}
