import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The apps that may run in a worker. Listed explicitly rather than
 * "../apps/*" so DOM-touching apps (terminal, IoDebug, ...) are never
 * bundled into the worker. Add an app here when you give it
 * `format: "worker"` in binfmt.
 */
const apps = import.meta.glob<RealmAppModule>([
  "../apps/echo/main.ts",
  "../apps/cat/main.ts",
  "../apps/loop/main.ts",
  "../apps/sh/main.ts",
  "../apps/ls/main.ts",
  "../apps/clear/main.ts",
]);

/** The realm's first and only message on its own channel: boot, carrying the port. */
self.onmessage = (event: MessageEvent) => {
  self.onmessage = null; // boot exactly once
  const port = event.ports[0];
  if (!isBoot(event.data, port)) {
    self.close(); // not from our kernel, or a version mismatch
    return;
  }
  void runApp(event.data, port, apps, "../apps");
};
