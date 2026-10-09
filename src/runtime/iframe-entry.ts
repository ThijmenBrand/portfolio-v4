import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The GUI apps that run in a sandboxed iframe (format: "iframe" in binfmt).
 * Explicit for the same reason as the worker list: only what's listed is
 * bundled into the app host. Keys must match binfmt `entry` + ".ts".
 *
 * Not here, by design: Desktop and Taskbar. They need the kernel's own
 * document (display.root / display.taskbar / struts) and stay in-page.
 */
const apps = import.meta.glob<RealmAppModule>([
  "../apps/hello/main.ts",
  "../apps/terminal/main.ts",
  "../apps/FsDebug/main.ts",
  "../apps/IoDebug/main.ts",
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
