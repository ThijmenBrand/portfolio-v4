import type { Executable } from "./proc/exec";
import type { WindowOptions } from "./windows/types";

export type FileEntry =
  | { format?: "module"; load: Executable; privileged?: boolean }
  | { format: "worker"; entry: string; privileged?: boolean }
  | {
      format: "iframe";
      entry: string;
      /** The window made at exec, which the app claims with windows.create. */
      window: WindowOptions;
      privileged?: boolean;
    };

const files: Record<string, FileEntry> = {
  "/ProgramFiles/echo": { format: "worker", entry: "echo" },
  "/ProgramFiles/cat": { format: "worker", entry: "cat" },
  "/ProgramFiles/loop": { format: "worker", entry: "loop" },
  "/ProgramFiles/sh": { format: "worker", entry: "sh" },
  "/ProgramFiles/ls": { format: "worker", entry: "ls" },
  "/ProgramFiles/clear": { format: "worker", entry: "clear" },
  "/ProgramFiles/hello": {
    format: "iframe",
    entry: "hello",
    window: { title: "Hello", width: 380, height: 300, minWidth: 260, minHeight: 200 },
  },

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
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
