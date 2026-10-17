import type { Executable } from "./proc/exec";
import type { WindowOptions } from "./windows/types";
import type { CommandSpec } from "../utils/commands";

/**
 * `privileged`: system powers (windows, signals). `setuid`: runs as root
 * whoever starts it (su, passwd). `admin`: only the admin group may run it.
 */
type Flags = { privileged?: boolean; setuid?: boolean; admin?: boolean };

/**
 * Which realm host page a worker/iframe boots in. "user" hosts may run code
 * from the VFS (blob: modules); only the JS interpreters below use them.
 */
export type Host = "system" | "user";

export type FileEntry = Flags &
  (
    | { format?: "module"; load: Executable }
    | { format: "worker"; entry: string; host?: Host }
    | {
        format: "iframe";
        entry: string;
        window: WindowOptions;
        host?: Host;
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
  /**
   * Actions offered in Spotlight (Cmd+K), handled by src/apps/<name>/commands.ts
   * -- see utils/commands.ts.
   */
  commands?: CommandSpec[];
  /** Its commands.ts exports search(os, query): results while Spotlight is typed in. */
  search?: boolean;
}

const SETUID = new Set(["su", "sudo", "passwd"]);

const folder = (key: string) => key.split("/")[2];
const bins = Object.keys(import.meta.glob("../bin/*/main.ts")).map(folder);
/** Apps with a commands.ts: each gets a headless program for its commands. */
const commandApps = Object.keys(import.meta.glob("../apps/*/commands.ts")).map(folder);

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

  // An app's Spotlight commands, run headless: `<app>.commands <id> <input>`.
  // Admin-only exactly when its app is.
  ...Object.fromEntries(
    commandApps.map((name): [string, FileEntry] => [
      `/ProgramFiles/${name}.commands`,
      {
        format: "worker",
        entry: `apps/${name}/commands`,
        admin: manifests[name]?.admin === true,
      },
    ]),
  ),

  // Interpreters for JS programs in the VFS: `#!/ProgramFiles/jsapp` (GUI)
  // and `#!/ProgramFiles/node` (CLI). See src/runtime/jsload.ts.
  "/ProgramFiles/jsapp": {
    format: "iframe",
    host: "user",
    entry: "runtime/jsapp",
    window: { title: "App", width: 640, height: 480, minWidth: 240, minHeight: 160 },
  },
  "/ProgramFiles/node": { format: "worker", host: "user", entry: "runtime/jsrun" },
  // An installed app's Spotlight command: `jscommand <file.app.js> <id> <input>`.
  "/ProgramFiles/jscommand": { format: "worker", host: "user", entry: "runtime/jscommand" },

  "/System/launcher": { format: "worker", entry: "System/Launcher/main" },

  // Cmd+K: find and open apps, switch windows, run apps' commands.
  "/System/Spotlight": {
    format: "iframe",
    entry: "System/Spotlight/main",
    privileged: true,
    window: {
      title: "Spotlight",
      surface: "overlay",
      width: 640,
      height: 58,
      minWidth: 280,
      minHeight: 58,
      maxHeight: 520,
      translucent: true,
    },
  },

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
  "/System/wallpaper": {
    load: () => import("../System/Wallpaper/main"),
    privileged: true,
  },
};

export const paths = Object.keys(files);

export const adminPaths = paths.filter((path) => files[path]?.admin);

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
