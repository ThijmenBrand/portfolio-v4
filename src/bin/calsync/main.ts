// calsync — keeps your calendar subscriptions fresh while the Calendar app is closed.
//
// No window and no icon: add it to Settings > Startup and it runs from login.
// It reuses the app's own store and sync code, so the cache it writes
// (~/.config/calendar/<id>.ics) is exactly what the Calendar app hydrates from
// and what upnext reads. Named calsync, not calendar, for the shadowing reason
// given at the top of bin/upnext/main.ts.
//
// The store is reopened on every tick instead of held: the Calendar app owns
// calendar.json too (view, todo switches), and a copy kept for hours would
// write stale values over whatever was changed in the meantime.
import type { AppInterface } from "../../kernel/syscalls/api";
import { openStore, type Source } from "../../apps/calendar/store.ts";
import { due, syncMany } from "../../apps/calendar/sync.ts";
import { print } from "../lib/input";

const TICK_MS = 60_000;

let running = false;

/** One pass: sync whatever is overdue, or has no cached body on this browser yet. */
async function tick(os: AppInterface): Promise<void> {
  if (running) return; // a slow feed must not stack passes up
  running = true;
  try {
    const store = await openStore(os, (message) => console.warn("[calsync]", message));
    const overdue = new Set<Source>(due(store.data.sources, Date.now()));
    for (const source of store.data.sources) {
      if (source.enabled && !overdue.has(source) && (await store.readCache(source.id)) === null) {
        overdue.add(source);
      }
    }
    if (overdue.size) await syncMany({ os, store, onChange: () => {} }, [...overdue]);
  } catch (error) {
    console.warn("[calsync]", error);
  } finally {
    running = false;
  }
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  // Daemonize, like upnext and timer: the shell gets its prompt back and
  // closing the terminal doesn't end the sync.
  if (args[0] !== "--bg") {
    await os.process.spawn("/ProgramFiles/calsync", ["--bg"]);
    // Started by autostart there is no terminal on fd 1: say it only if someone is listening.
    await print(os, 1, "calsync: syncing calendars in the background\n").catch(() => {});
    return os.process.exit(0);
  }
  await os.process.setsid().catch(() => {});
  // Nothing to repaint, but SIGHUP's default is to terminate (Settings sends
  // it on an accent change), so swallow it.
  await os.process.onSignal("SIGHUP", () => {});

  void tick(os);
  await os.timers.setInterval(() => void tick(os), TICK_MS);
}
