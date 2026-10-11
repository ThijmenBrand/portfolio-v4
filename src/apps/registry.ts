import type { AppManifest } from "../kernel/binfmt";

export interface AppEntry {
  /** Stable, URL-safe id: what ?launch=<id> refers to (System/launcher). */
  id: string;
  name: string;
  icon: string;
  exec: string;
}

const manifests = import.meta.glob<AppManifest>("./*/app.ts", {
  eager: true,
  import: "default",
});

/** Every GUI app whose app.ts declares `desktop`, plus the system ones. */
export const registry: AppEntry[] = [
  ...Object.entries(manifests).flatMap(([key, { desktop }]) => {
    const id = key.split("/")[1]; // "./resume/app.ts" -> "resume"
    return desktop ? [{ id, ...desktop, exec: `/ProgramFiles/${id}` }] : [];
  }),
  {
    id: "task-manager",
    name: "Task Manager",
    icon: "/assets/icons/task-manager.png",
    exec: "/System/DebugPs",
  },
];
