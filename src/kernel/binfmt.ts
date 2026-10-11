import type { Executable } from "./proc/exec";
import type { WindowOptions } from "./windows/types";

export type FileEntry =
  | { format?: "module"; load: Executable; privileged?: boolean }
  | { format: "worker"; entry: string; privileged?: boolean }
  | {
      format: "iframe";
      entry: string;
      /** The window made at exec, which the app claims with windows.create. */
      window: WindowOptions;
      privileged?: boolean;
    };

/** What a GUI app declares in src/apps/<name>/app.ts. */
export interface AppManifest {
  window: WindowOptions;
  /** Present when the app gets a desktop icon (src/apps/registry.ts). */
  desktop?: { name: string; icon: string };
}

/** "../bin/ls/main.ts" -> "ls" */
const folder = (key: string) => key.split("/")[2];

// Programs without a UI: every src/bin/<name>/main.ts is a worker at
// /ProgramFiles/<name>. Not eager: only the keys are used, so no program
// code is bundled into the kernel.
const bins = Object.keys(import.meta.glob("../bin/*/main.ts")).map(folder);

/** GUI apps: src/apps/<name>/app.ts, keyed by <name>. */
const manifests: Record<string, AppManifest> = Object.fromEntries(
  Object.entries(
    import.meta.glob<AppManifest>("../apps/*/app.ts", {
      eager: true,
      import: "default",
    }),
  ).map(([key, manifest]) => [folder(key), manifest]),
);

const files: Record<string, FileEntry> = {
  ...Object.fromEntries(
    bins.map((name) => [
      `/ProgramFiles/${name}`,
      { format: "worker" as const, entry: `bin/${name}/main` },
    ]),
  ),

  // GUI apps: sandboxed iframes. `window` is created at exec; the app
  // claims it with windows.create (which applies the title).
  ...Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [
      `/ProgramFiles/${name}`,
      { format: "iframe" as const, entry: `apps/${name}/main`, window: manifest.window },
    ]),
  ),

  "/System/launcher": { format: "worker", entry: "System/Launcher/main" },

  "/System/DebugPs": {
    format: "iframe",
    entry: "System/DebugPs/debug-ps",
    // privileged is a per-process grant, checked by the kernel on every call;
    // it works the same over the wire as in-page.
    privileged: true,
    window: { title: "Process Monitor", width: 760, height: 440, minWidth: 520, minHeight: 260 },
  },

  // The shell surface itself: needs the kernel's document, stays in-page.
  "/System/desktop": {
    load: () => import("../System/Desktop/desktop"),
    privileged: true,
  },
  "/System/Taskbar": {
    load: () => import("../System/Taskbar/main"),
    privileged: true,
  },
};

/** Every executable path; the kernel lists these as read-only directories. */
export const paths = Object.keys(files);

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
