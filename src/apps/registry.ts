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
];
