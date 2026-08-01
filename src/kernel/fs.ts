import type { Executable } from "./types";

export interface FileEntry {
  load: Executable;
  privileged?: boolean;
}

const files: Record<string, FileEntry> = {
  "/System/desktop": {
    load: () => import("../System/Desktop/desktop"),
    privileged: true,
  },
  "/ProgramFiles/terminal": {
    load: () => import("../apps/terminal/main"),
  },
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}

export function isExecutable(mod: unknown): mod is Executable {
  // check if its a function and has a main property that is a function
  return typeof mod === "object" && typeof (mod as any).main === "function";
}
