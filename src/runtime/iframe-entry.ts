import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The apps that may run in an iframe (format: "iframe" in binfmt).
 * Explicit for the same reason as the worker list: only what's listed is
 * bundled into the app host.
 */
const apps = import.meta.glob<RealmAppModule>(["../apps/hello/main.ts"]);

/**
 * Boot arrives from the kernel via contentWindow.postMessage. Only accept it
 * from our direct parent — anything else on the page can post to us too.
 */
function onBoot(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  const port = event.ports[0];
  if (!isBoot(event.data, port)) return;

  window.removeEventListener("message", onBoot); // boot exactly once
  void runApp(event.data, port, apps, "../apps");
}

window.addEventListener("message", onBoot);
