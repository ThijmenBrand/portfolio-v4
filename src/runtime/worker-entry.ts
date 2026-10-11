import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The programs that may run in a worker (format: "worker" in binfmt): every
 * src/bin/<name>/main.ts, plus the launcher. Only src/bin is globbed, so
 * DOM-touching apps (src/apps) are never bundled into the worker. Keys must
 * match binfmt `entry` + ".ts".
 */
const apps = import.meta.glob<RealmAppModule>([
  "../bin/*/main.ts",
  "../System/Launcher/main.ts",
]);

/**
 * Boot: re-delivered by the worker's bootstrap (src/runtime/worker-host.ts)
 * once this module has loaded, carrying the kernel port.
 */
self.onmessage = (event: MessageEvent) => {
  self.onmessage = null; // boot exactly once
  const port = event.ports[0];
  if (!port || !isBoot(event.data, port)) {
    self.close(); // not from our kernel, or a version mismatch
    return;
  }
  void runApp(event.data, port, apps);
};
