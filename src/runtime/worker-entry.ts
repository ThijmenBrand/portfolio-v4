import { bootWorker, type RealmAppModule } from "./boot";

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

bootWorker(apps);
