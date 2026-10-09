import type { WindowCommmands, WindowRecord } from "../types";

/**
 * Was there a recent user gesture? A click inside an iframe app activates
 * the kernel's page too (user activation propagates to ancestors). Where the
 * API is missing, assume yes: better a stolen focus than an unclickable app.
 */
function userIsActive(): boolean {
  return navigator.userActivation?.isActive ?? true;
}

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
  // focused element is an iframe inside this window, raise the window —
  // but only if a person did it. An app calling .focus() on itself (e.g. a
  // terminal focusing its input at startup) must not be able to steal the
  // foreground; then the keyboard goes back to the window that has focus.
  const handleBlur = () => {
    // activeElement is updated after blur fires; check on the next task.
    setTimeout(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLIFrameElement)) return;
      if (!windowElement.contains(active)) return;
      if (userIsActive()) commands.focusWindow();
      else commands.refocusActive();
    }, 0);
  };
  window.addEventListener("blur", handleBlur);

  return () => {
    windowElement.removeEventListener("mousedown", handleFocus);
    window.removeEventListener("blur", handleBlur);
  };
}
