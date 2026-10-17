import { bootWorker, type RealmAppModule } from "./boot";

/**
 * The programs that may run in a worker (format: "worker" in binfmt): every
 * src/bin/<name>/main.ts, the apps' headless commands (src/apps/<name>/commands.ts,
 * which must not touch the DOM) and the launcher. App main.ts files are never
 * globbed, so DOM-touching apps are never bundled into the worker. Keys must
 * match binfmt `entry` + ".ts".
 */
const apps = import.meta.glob<RealmAppModule>([
  "../bin/*/main.ts",
  "../apps/*/commands.ts",
  "../System/Launcher/main.ts",
]);

bootWorker(apps);
