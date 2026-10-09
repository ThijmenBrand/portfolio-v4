export interface AppEntry {
  /** Stable, URL-safe id: what ?launch=<id> refers to (System/launcher). */
  id: string;
  name: string;
  icon: string;
  exec: string;
}

export const registry: AppEntry[] = [
  {
    id: "resume",
    name: "Resume",
    icon: "/assets/icons/resume.svg",
    exec: "/ProgramFiles/resume",
  },
  {
    id: "terminal",
    name: "Terminal",
    icon: "/assets/icons/terminal.png",
    exec: "/ProgramFiles/terminal",
  },
  {
    id: "task-manager",
    name: "Task Manager",
    icon: "/assets/icons/task-manager.png",
    exec: "/System/DebugPs",
  },
];
