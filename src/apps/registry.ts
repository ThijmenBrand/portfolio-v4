import type { AppModule } from "../kernel/types";

export interface AppEntry {
  id: string;
  name: string;
  icon: string;
  load: () => Promise<AppModule>;
  singleton?: boolean;
  hidden?: boolean;
}

export const registry: AppEntry[] = [
  {
    id: "terminal",
    name: "Terminal",
    icon: "/src/apps/terminal/icon.png",
    load: () => import("./terminal/main"),
  },
];
