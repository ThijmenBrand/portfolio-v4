import type { WindowCommmands, WindowRecord } from "../types";

export function enableControls(
  record: Readonly<WindowRecord>,
  commands: WindowCommmands,
): () => void {
  const windowElement = record.root;

  const closeButton = windowElement.querySelector(
    "#window-close-button",
  ) as HTMLElement | null;
  const maximizeButton = windowElement.querySelector(
    "#window-maximize-button",
  ) as HTMLElement | null;
  const minimizeButton = windowElement.querySelector(
    "#window-minimize-button",
  ) as HTMLElement | null;

  const closeHandler = () => {
    commands.requestClose();
  };

  const maximizeHandler = () => {
    if (record.state === "maximized") {
      commands.setWindowState("normal");
    } else {
      commands.setWindowState("maximized");
    }
  };

  const minimizeHandler = () => {
    commands.minimizeWindow();
  };

  if (closeButton) {
    closeButton.addEventListener("click", closeHandler);
  }

  if (maximizeButton) {
    maximizeButton.addEventListener("click", maximizeHandler);
  }

  if (minimizeButton) {
    minimizeButton.addEventListener("click", minimizeHandler);
  }

  return () => {
    if (closeButton) {
      closeButton.removeEventListener("click", closeHandler);
    }
    if (maximizeButton) {
      maximizeButton.removeEventListener("click", maximizeHandler);
    }
    if (minimizeButton) {
      minimizeButton.removeEventListener("click", minimizeHandler);
    }
  };
}
