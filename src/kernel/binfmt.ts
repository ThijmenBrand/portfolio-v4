import type { Executable } from "./proc/exec";
import type { WindowOptions } from "./windows/types";

/**
 * `privileged`: system powers (windows, signals). `setuid`: runs as root
 * whoever starts it (su, passwd). `admin`: only the admin group may run it.
 */
type Flags = { privileged?: boolean; setuid?: boolean; admin?: boolean };

export type FileEntry = Flags &
  (
    | { format?: "module"; load: Executable }
    | { format: "worker"; entry: string }
    | {
        format: "iframe";
        entry: string;
        window: WindowOptions;
      }
    | { format: "web"; url: string; window: WindowOptions }
  );

/** What a GUI app declares in src/apps/<name>/app.ts. */
export interface AppManifest {
  window: WindowOptions;
  url?: string;
  /** Shown in the taskbar's app menu (and pinnable to the desktop or dock). */
  launcher?: { name: string; icon: string };
  admin?: boolean;
}

const SETUID = new Set(["su", "sudo", "passwd"]);

const folder = (key: string) => key.split("/")[2];
const bins = Object.keys(import.meta.glob("../bin/*/main.ts")).map(folder);

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
      {
        format: "worker" as const,
        entry: `bin/${name}/main`,
        setuid: SETUID.has(name),
      },
    ]),
  ),

  ...Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]): [string, FileEntry] => [
      `/ProgramFiles/${name}`,
      manifest.url
        ? {
            format: "web",
            url: manifest.url,
            window: manifest.window,
            admin: manifest.admin === true,
          }
        : {
            format: "iframe",
            entry: `apps/${name}/main`,
            window: manifest.window,
            admin: manifest.admin === true,
          },
    ]),
  ),

  "/System/launcher": { format: "worker", entry: "System/Launcher/main" },

  "/System/login": {
    load: () => import("../System/Login/main"),
    privileged: true,
  },

  "/System/DebugPs": {
    format: "iframe",
    entry: "System/DebugPs/debug-ps",
    privileged: true,
    window: {
      title: "Process Monitor",
      width: 760,
      height: 440,
      minWidth: 520,
      minHeight: 260,
    },
  },

  "/System/desktop": {
    load: () => import("../System/Desktop/desktop"),
    privileged: true,
  },
  "/System/Taskbar": {
    load: () => import("../System/Taskbar/main"),
    privileged: true,
  },
};

export const paths = Object.keys(files);

export const adminPaths = paths.filter((path) => files[path]?.admin);

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
