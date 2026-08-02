export interface AppEntry {
  name: string;
  icon: string;
  exec: string;
}

export const registry: AppEntry[] = [
  {
    name: "Terminal",
    icon: "/src/apps/terminal/icon.png",
    exec: "/ProgramFiles/terminal",
  },
  {
    name: "Task Manager",
    icon: "/src/System/DebugPs/icon.png",
    exec: "/System/DebugPs",
  },
  {
    name: "Files",
    icon: "/assets/icons/default-app.svg",
    exec: "/ProgramFiles/fs-debug",
  },
];
