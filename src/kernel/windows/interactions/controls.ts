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

  // Double-clicking the title bar toggles maximize (not when on a button).
  const topBar = windowElement.querySelector("#window-top-bar") as HTMLElement | null;
  const titleBarDoubleClick = (event: MouseEvent) => {
    if ((event.target as Element).closest(".window-button")) return;
    maximizeHandler();
  };
  topBar?.addEventListener("dblclick", titleBarDoubleClick);

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
    topBar?.removeEventListener("dblclick", titleBarDoubleClick);
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
