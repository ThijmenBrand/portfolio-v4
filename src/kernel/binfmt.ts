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
  // Programs without a UI: workers.
  "/ProgramFiles/echo": { format: "worker", entry: "apps/echo/main" },
  "/ProgramFiles/cat": { format: "worker", entry: "apps/cat/main" },
  "/ProgramFiles/loop": { format: "worker", entry: "apps/loop/main" },
  "/ProgramFiles/sh": { format: "worker", entry: "apps/sh/main" },
  "/ProgramFiles/ls": { format: "worker", entry: "apps/ls/main" },
  "/ProgramFiles/clear": { format: "worker", entry: "apps/clear/main" },
  "/ProgramFiles/io-child": { format: "worker", entry: "apps/IoDebug/child" },

  // GUI apps: sandboxed iframes. `window` is created at exec; the app
  // claims it with windows.create (which applies the title).
  "/ProgramFiles/hello": {
    format: "iframe",
    entry: "apps/hello/main",
    window: { title: "Hello", width: 380, height: 300, minWidth: 260, minHeight: 200 },
  },
  "/ProgramFiles/terminal": {
    format: "iframe",
    entry: "apps/terminal/main",
    window: { title: "Terminal", width: 680, height: 440, minWidth: 360, minHeight: 220 },
  },
  "/ProgramFiles/fs-debug": {
    format: "iframe",
    entry: "apps/FsDebug/main",
    window: { title: "Files (debug)", width: 780, height: 480, minWidth: 520, minHeight: 320 },
  },
  "/ProgramFiles/IoDebug": {
    format: "iframe",
    entry: "apps/IoDebug/main",
    window: { title: "io (debug)", width: 860, height: 520, minWidth: 600, minHeight: 340 },
  },
  "/System/DebugPs": {
    format: "iframe",
    entry: "System/DebugPs/debug-ps",
    // privileged is a per-process grant, checked by the kernel on every call;
    // it works the same over the wire as in-page.
    privileged: true,
    window: { title: "Process Monitor", width: 760, height: 440, minWidth: 520, minHeight: 260 },
  },

  // The shell surface itself: needs the kernel's document, stays in-page.
  "/System/desktop": {
    load: () => import("../System/Desktop/desktop"),
    privileged: true,
  },
  "/System/Taskbar": {
    load: () => import("../System/Taskbar/main"),
    privileged: true,
  },
};

export function resolve(path: string): FileEntry | undefined {
  return files[path];
}
