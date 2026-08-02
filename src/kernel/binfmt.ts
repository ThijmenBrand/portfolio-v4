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
  "/System/DebugPs": {
    load: () => import("../System/DebugPs/debug-ps"),
    privileged: true,
  },
  "/System/Taskbar": {
    load: () => import("../System/Taskbar/main"),
    privileged: true,
  },
  "/ProgramFiles/fs-debug": {
    load: () => import("../apps/FsDebug/main"),
  },
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
