// session — brings your windows back after a reload, like "reopen windows" on a Mac.
//
// A reload is a reboot here: every process is gone. This remembers which
// programs had a window open, and where, in ~/.config/session.json, and
// opens them again at login. Started from /etc/autostart, after the taskbar.
//
// Two jobs, in order: restore once (unless the page URL asked for specific
// apps with ?launch=), then keep the file current by looking at the desktop
// every couple of seconds and writing when something changed.
import type { AppInterface } from "../../kernel/syscalls/api";
import type { WindowInfo } from "../../kernel/windows/types";
import type { Pid, Rect, WindowId } from "../../kernel/types";
import { ensureConfigDir } from "../../utils/settings";
import { print } from "../lib/input";
import { fit, hasSession, parseSession, plan, serialize, snapshot, type OpenWindow, type SavedWindow } from "./model.ts";

const SAVE_MS = 2_000;
const POLL_MS = 150;
/** Autostart opens its windows in the first moments; wait for them to stop arriving. */
const SETTLE_QUIET_POLLS = 2;
const SETTLE_CAP_MS = 3_000;
const WINDOW_WAIT_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function current(os: AppInterface, home: string): Promise<OpenWindow[]> {
  const [windows, processes] = await Promise.all([os.windows.list(), os.process.list()]);
  return snapshot(windows, processes, home);
}

/** Returns once the number of windows has stopped changing. */
async function settle(os: AppInterface): Promise<void> {
  const until = Date.now() + SETTLE_CAP_MS;
  let last = -1;
  let quiet = 0;
  while (quiet < SETTLE_QUIET_POLLS && Date.now() < until) {
    const count = (await os.windows.list()).length;
    quiet = count === last ? quiet + 1 : 0;
    last = count;
    await sleep(POLL_MS);
  }
}

async function windowOf(os: AppInterface, pid: Pid): Promise<WindowInfo | undefined> {
  const until = Date.now() + WINDOW_WAIT_MS;
  do {
    const found = (await os.windows.list()).find((win) => win.pid === pid);
    if (found) return found;
    await sleep(100);
  } while (Date.now() < until);
  return undefined;
}

/** Put one window where it was: its floating frame, then maximized or tiled on top of that. */
async function place(
  os: AppInterface,
  windowId: WindowId,
  entry: SavedWindow,
  area: Rect,
): Promise<void> {
  await os.windows.setFrame(windowId, fit(entry.frame, area));
  if (entry.state === "maximized") await os.windows.tile(windowId, "maximize");
  else if (entry.state === "tiled" && entry.tile) {
    await os.windows.tile(windowId, entry.tile).catch(() => {});
  }
}

async function restore(
  os: AppInterface,
  todo: ReturnType<typeof plan>,
  overrule: boolean,
): Promise<void> {
  const area = await os.display.workArea();
  // The session wins over autostart: a window that was closed stays closed.
  if (overrule) {
    for (const win of todo.extra) await os.process.kill(win.pid as Pid, "SIGTERM").catch(() => {});
  }
  for (const { entry, windowId } of todo.adopt) {
    await place(os, windowId as WindowId, entry, area).catch(() => {});
  }
  for (const entry of todo.reopen) {
    try {
      const pid = await os.process.spawn(entry.path, entry.args);
      const win = await windowOf(os, pid);
      if (!win) continue; // not a windowed program any more: leave it be
      await place(os, win.windowId, entry, area);
    } catch (error) {
      console.warn(`[session] couldn't reopen ${entry.path}:`, error);
    }
  }
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  // Daemonize, like upnext and timer.
  if (args[0] !== "--bg") {
    await os.process.spawn("/ProgramFiles/session", ["--bg"]);
    // Started by autostart there is no terminal on fd 1: say it only if someone is listening.
    await print(os, 1, "session: remembering your windows\n").catch(() => {});
    return os.process.exit(0);
  }
  await os.process.setsid().catch(() => {});
  await os.process.onSignal("SIGHUP", () => {});

  const home = (await os.process.env()).HOME ?? "/";
  const file = `${await ensureConfigDir(os)}/session.json`;

  // A link that names apps (?launch=) is a statement of what to open.
  const { search } = await os.shell.location();
  const explicit = new URLSearchParams(search).has("launch");
  const text = await os.fs.readTextFile(file).catch(() => null);
  const saved = explicit ? [] : parseSession(text);
  // Only a link that names apps, or no saved session at all (a first visit, a
  // reboot), leaves autostart in charge of what opens.
  const overrule = !explicit && hasSession(text);

  await settle(os);
  const todo = plan(saved, await current(os, home));
  await restore(os, todo, overrule);

  // Only now, with the desktop back, is the file written again: a half-restored
  // one must never replace the whole. Before that nothing touches it.
  let written = serialize(await current(os, home));
  await os.fs.writeTextFile(file, written).catch(() => {});

  await os.timers.setInterval(() => {
    void (async () => {
      // Logging out kills the session's programs one by one. Once this user's
      // desktop is gone, what is left is not what they had open.
      const processes = await os.process.list();
      const self = processes.find((proc) => proc.pid === os.process.pid);
      const desktop = processes.some(
        (proc) =>
          proc.path === "/System/desktop" &&
          proc.uid === self?.uid &&
          (proc.status === "running" || proc.status === "loading"),
      );
      if (!desktop) return;
      const text = serialize(await current(os, home));
      if (text === written) return;
      written = text;
      await os.fs.writeTextFile(file, text).catch(() => {});
    })().catch((error: unknown) => console.warn("[session]", error));
  }, SAVE_MS);
}
