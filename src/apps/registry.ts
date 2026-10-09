export interface AppEntry {
  name: string;
  icon: string;
  exec: string;
}

export const registry: AppEntry[] = [
  {
    name: "Resume",
    icon: "/assets/icons/resume.svg",
    exec: "/ProgramFiles/resume",
  },
  {
    name: "Terminal",
    icon: "/assets/icons/terminal.png",
    exec: "/ProgramFiles/terminal",
  },
  {
    name: "Task Manager",
    icon: "/assets/icons/task-manager.png",
    exec: "/System/DebugPs",
  },
];
