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
  "/ProgramFiles/IoDebug": {
    load: () => import("../apps/IoDebug/main"),
  },
  "/ProgramFiles/io-child": {
    load: () => import("../apps/IoDebug/child"),
  },
  "/ProgramFiles/sh": { load: () => import("../apps/sh/main") },
  "/ProgramFiles/echo": { load: () => import("../apps/echo/main") },
  "/ProgramFiles/cat": { load: () => import("../apps/cat/main") },
  "/ProgramFiles/loop": { load: () => import("../apps/loop/main") },
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
