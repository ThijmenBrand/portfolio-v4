import { isBoot, runApp, type RealmAppModule } from "./boot";

/**
 * The programs that may run in a worker (format: "worker" in binfmt): the
 * ones without a UI. Listed explicitly so DOM-touching apps are never
 * bundled into the worker. Keys must match binfmt `entry` + ".ts".
 */
const apps = import.meta.glob<RealmAppModule>([
  "../apps/echo/main.ts",
  "../apps/cat/main.ts",
  "../apps/sh/main.ts",
  "../apps/ls/main.ts",
  "../apps/clear/main.ts",
  "../apps/mkdir/main.ts",
  "../apps/rmdir/main.ts",
  "../apps/rm/main.ts",
  "../apps/touch/main.ts",
  "../apps/cp/main.ts",
  "../apps/mv/main.ts",
  "../apps/ps/main.ts",
  "../apps/kill/main.ts",
  "../apps/head/main.ts",
  "../apps/tail/main.ts",
  "../apps/wc/main.ts",
  "../apps/grep/main.ts",
  "../apps/sort/main.ts",
  "../apps/uniq/main.ts",
  "../apps/tee/main.ts",
  "../apps/tree/main.ts",
  "../apps/find/main.ts",
  "../apps/stat/main.ts",
  "../apps/sleep/main.ts",
  "../apps/date/main.ts",
  "../apps/whoami/main.ts",
  "../apps/uname/main.ts",
  "../apps/open/main.ts",
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
