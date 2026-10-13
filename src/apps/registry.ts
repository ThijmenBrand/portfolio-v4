import type { AppManifest } from "../kernel/binfmt";
import type { AppInterface } from "../kernel/syscalls/api";
import { readManifest, USER_APPS_DIR } from "../utils/appfile";

export interface AppEntry {
  /** Stable, URL-safe id: what ?launch=<id> refers to (System/launcher). */
  id: string;
  name: string;
  icon: string;
  exec: string;
  admin?: boolean;
}

const manifests = import.meta.glob<AppManifest>("./*/app.ts", {
  eager: true,
  import: "default",
});

export const registry: AppEntry[] = [
  ...Object.entries(manifests).flatMap(([key, { launcher, admin }]) => {
    const id = key.split("/")[1]; // "./resume/app.ts" -> "resume"
    return launcher
      ? [{ id, ...launcher, exec: `/ProgramFiles/${id}`, admin }]
      : [];
  }),
  {
    id: "task-manager",
    name: "Task Manager",
    icon: "/assets/icons/task-manager.svg",
    exec: "/System/DebugPs",
  },
];

const DEFAULT_ICON = "/assets/icons/default-app.svg";

/** Windowless programs that live in the topbar: offered as startup items, not in the app menu. */
export const menubarApps: AppEntry[] = [
  { id: "timer", name: "Timer (menu bar)", icon: DEFAULT_ICON, exec: "/ProgramFiles/timer" },
];

/**
 * The user's installed apps: every *.js in ~/.local/share/apps, named and
 * iconed by its //@app manifest (read as data, never run). Unreadable or
 * manifest-less files still show, under their file name.
 */
export async function userApps(os: AppInterface): Promise<AppEntry[]> {
  const dir = `${(await os.process.env()).HOME ?? "/"}/${USER_APPS_DIR}`;
  const files = await os.fs.readdir(dir).catch(() => []);
  return Promise.all(
    files
      .filter((file) => file.kind === "file" && file.name.endsWith(".js"))
      .map(async (file): Promise<AppEntry> => {
        const exec = `${dir}/${file.name}`;
        const manifest = await readManifest((p) => os.fs.readFile(p), exec);
        return {
          id: `user-${file.name.replace(/(\.app)?\.js$/, "")}`,
          name: manifest?.name ?? file.name.replace(/(\.app)?\.js$/, ""),
          icon: manifest?.icon ?? DEFAULT_ICON,
          exec,
        };
      }),
  );
}

/** Built-in apps, then the user's. */
export async function allApps(os: AppInterface): Promise<AppEntry[]> {
  return [...registry, ...(await userApps(os))];
}
