import { hotkeyFor } from "../kernel/syscalls/hotkeys";
import { isBoot, runApp, type AppLoaders } from "./boot";

/**
 * What every iframe realm page does besides choosing its apps: boot once,
 * from our kernel, and forward the input the kernel needs to see. Shared by
 * app-host (iframe-entry.ts) and user-app-host (user-entry.ts).
 */
export function bootFrame(apps: AppLoaders): void {
  /**
   * Boot arrives from the kernel via contentWindow.postMessage. Only accept it
   * from our direct parent — anything else on the page can post to us too.
   */
  const onBoot = (event: MessageEvent): void => {
    if (event.source !== window.parent) return;
    const port = event.ports[0];
    if (!isBoot(event.data, port)) return;

    window.removeEventListener("message", onBoot); // boot exactly once
    void runApp(event.data, port, apps);
  };
  window.addEventListener("message", onBoot);

  // A click inside this frame never reaches the kernel's DOM, so say so: the
  // kernel raises our window. Capture phase, so an app's stopPropagation can't
  // swallow it.
  window.addEventListener(
    "pointerdown",
    () => window.parent.postMessage({ t: "realm-pointerdown" }, "*"),
    true,
  );

  // Same for the launcher shortcut (Ctrl/Cmd+Space, see the taskbar),
  // Ctrl+W / Ctrl/Cmd+` (close / cycle windows) and Ctrl+Alt+Arrow (snap, see
  // the window manager), and the system hotkeys (Ctrl/Cmd+K, see
  // kernel/syscalls/hotkeys.ts): keys in this frame never reach the kernel's document either.
  const arrows: Record<string, string> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  window.addEventListener(
    "keydown",
    (event) => {
      const hotkey = hotkeyFor(event);
      if (hotkey) {
        event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage({ t: "realm-hotkey", name: hotkey }, "*");
      } else if (event.code === "Space" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        window.parent.postMessage({ t: "realm-launcher" }, "*");
      } else if (event.key.toLowerCase() === "w" && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        window.parent.postMessage({ t: "realm-close" }, "*");
      } else if (event.code === "Backquote" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        window.parent.postMessage({ t: "realm-cycle" }, "*");
      } else if (
        arrows[event.key] &&
        event.ctrlKey &&
        event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        window.parent.postMessage({ t: "realm-tile", arrow: arrows[event.key] }, "*");
      }
    },
    true,
  );
}
