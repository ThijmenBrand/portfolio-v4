import type { AppManifest } from "../kernel/binfmt";

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
