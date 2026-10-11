import type { RealmAppModule } from "./boot";
import { bootFrame } from "./frame";

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

bootFrame(apps);
