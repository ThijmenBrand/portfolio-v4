import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The GUI apps that run in a sandboxed iframe (format: "iframe" in binfmt):
 * every src/apps/<name>/main.ts, plus the process monitor. Only what's
 * globbed is bundled into the app host. Keys must match binfmt `entry` + ".ts".
 *
 * Not here, by design: Desktop and Taskbar. They need the kernel's own
 * document (display.root / display.taskbar / struts) and stay in-page.
 */
const apps = import.meta.glob<RealmAppModule>([
  "../apps/*/main.ts",
  "../System/DebugPs/debug-ps.ts",
]);

/**
 * Boot arrives from the kernel via contentWindow.postMessage. Only accept it
 * from our direct parent — anything else on the page can post to us too.
 */
function onBoot(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  const port = event.ports[0];
  if (!isBoot(event.data, port)) return;

  window.removeEventListener("message", onBoot); // boot exactly once
  void runApp(event.data, port, apps);
}

window.addEventListener("message", onBoot);

// A click inside this frame never reaches the kernel's DOM, so say so: the
// kernel raises our window. Capture phase, so an app's stopPropagation can't
// swallow it.
window.addEventListener(
  "pointerdown",
  () => window.parent.postMessage({ t: "realm-pointerdown" }, "*"),
  true,
);

// Same for the launcher shortcut (Ctrl/Cmd+Space, see the taskbar) and
// Ctrl+W (close window, see the window manager): keys in
// this frame never reach the kernel's document either.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.code === "Space" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      window.parent.postMessage({ t: "realm-launcher" }, "*");
    } else if (event.key.toLowerCase() === "w" && event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.parent.postMessage({ t: "realm-close" }, "*");
    }
  },
  true,
);
