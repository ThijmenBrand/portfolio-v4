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
  "/ProgramFiles/mkdir": { format: "worker", entry: "apps/mkdir/main" },
  "/ProgramFiles/rmdir": { format: "worker", entry: "apps/rmdir/main" },
  "/ProgramFiles/rm": { format: "worker", entry: "apps/rm/main" },
  "/ProgramFiles/touch": { format: "worker", entry: "apps/touch/main" },
  "/ProgramFiles/cp": { format: "worker", entry: "apps/cp/main" },
  "/ProgramFiles/mv": { format: "worker", entry: "apps/mv/main" },
  "/ProgramFiles/ps": { format: "worker", entry: "apps/ps/main" },
  "/ProgramFiles/kill": { format: "worker", entry: "apps/kill/main" },
  "/ProgramFiles/head": { format: "worker", entry: "apps/head/main" },
  "/ProgramFiles/tail": { format: "worker", entry: "apps/tail/main" },
  "/ProgramFiles/wc": { format: "worker", entry: "apps/wc/main" },
  "/ProgramFiles/grep": { format: "worker", entry: "apps/grep/main" },
  "/ProgramFiles/sort": { format: "worker", entry: "apps/sort/main" },
  "/ProgramFiles/uniq": { format: "worker", entry: "apps/uniq/main" },
  "/ProgramFiles/tee": { format: "worker", entry: "apps/tee/main" },
  "/ProgramFiles/tree": { format: "worker", entry: "apps/tree/main" },
  "/ProgramFiles/find": { format: "worker", entry: "apps/find/main" },
  "/ProgramFiles/stat": { format: "worker", entry: "apps/stat/main" },
  "/ProgramFiles/sleep": { format: "worker", entry: "apps/sleep/main" },
  "/ProgramFiles/date": { format: "worker", entry: "apps/date/main" },
  "/ProgramFiles/whoami": { format: "worker", entry: "apps/whoami/main" },
  "/ProgramFiles/uname": { format: "worker", entry: "apps/uname/main" },
  "/ProgramFiles/open": { format: "worker", entry: "apps/open/main" },
  "/System/launcher": { format: "worker", entry: "System/Launcher/main" },

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
