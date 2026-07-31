import type { Kernel } from "../kernel/types";

export interface App {
  id: string;
  name: string;
  icon: string;
  load: () => Promise<{ main: (os: Kernel) => void | Promise<void> }>;
}
