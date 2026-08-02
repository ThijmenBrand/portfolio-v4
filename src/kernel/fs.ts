import type { Executable } from "./proc/exec";

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
  "/ProgramFiles/debug-ps": {
    load: () => import("../System/DebugPs/debug-ps"),
    privileged: true,
  },
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
