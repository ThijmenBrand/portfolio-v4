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
  "/ProgramFiles/sh": { format: "worker", entry: "apps/sh/main" },
  "/ProgramFiles/ls": { format: "worker", entry: "apps/ls/main" },
  "/ProgramFiles/clear": { format: "worker", entry: "apps/clear/main" },

  // GUI apps: sandboxed iframes. `window` is created at exec; the app
  // claims it with windows.create (which applies the title).
  "/ProgramFiles/resume": {
    format: "iframe",
    entry: "apps/resume/main",
    window: {
      title: "Resume — Thijmen Brand",
      x: 170,
      y: 40,
      width: 760,
      height: 640,
      minWidth: 380,
      minHeight: 320,
    },
  },
  "/ProgramFiles/terminal": {
    format: "iframe",
    entry: "apps/terminal/main",
    window: { title: "Terminal", width: 680, height: 440, minWidth: 360, minHeight: 220 },
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
