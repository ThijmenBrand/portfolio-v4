// upnext — the next event from your calendars, in the top bar.
//
// Named upnext rather than calendar on purpose: binfmt puts src/bin/<name>
// and src/apps/<name> at the same /ProgramFiles/<name>, with the apps spread
// last, so a src/bin/calendar would be silently shadowed by the Calendar app.
//
// Read-only. It never fetches: the Calendar app owns syncing, and this just
// reads what the app has already cached, plus the calendars of your own the
// app keeps (see apps/calendar/mine.ts).
import type { AppInterface } from "../../kernel/syscalls/api";
import { expandSeries, groupByUid } from "../../apps/calendar/expand.ts";
import { CLOUD_DIR, FILE, readCalendar } from "../../apps/calendar/mine.ts";
import { parseIcs, type CalEvent } from "../../apps/calendar/parse.ts";
import { print } from "../lib/input";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v2M10.5 1.5v2"/></svg>`;
const REFRESH_MS = 60_000;
const LABEL_MAX = 22;

interface Upcoming {
  at: Date;
  allDay: boolean;
  title: string;
}

interface Stored {
  sources?: { id?: string; name?: string; enabled?: boolean }[];
}

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * The visible calendars of your own, as event lists. The same folder the app
 * picks: the cloud one if the mount lets us list it, this browser's if not.
 */
async function mine(os: AppInterface, home: string): Promise<CalEvent[][]> {
  let dir = CLOUD_DIR;
  let names = await os.fs.readdir(dir).catch(() => null);
  if (!names) {
    dir = `${home}/.config/calendar/mine`;
    names = await os.fs.readdir(dir).catch(() => []);
  }
  const out: CalEvent[][] = [];
  for (const entry of names) {
    const match = entry.kind === "file" ? FILE.exec(entry.name) : null;
    if (!match) continue;
    const body = await os.fs.readTextFile(`${dir}/${entry.name}`).catch(() => null);
    if (body === null) continue;
    const calendar = readCalendar(match[1]!, body);
    if (!calendar.hidden) out.push(calendar.events);
  }
  return out;
}

/** The subscriptions' cached bodies, as event lists. */
async function subscribed(os: AppInterface, home: string): Promise<CalEvent[][]> {
  let config: Stored;
  try {
    config = JSON.parse(await os.fs.readTextFile(`${home}/.config/calendar.json`)) as Stored;
  } catch {
    return [];
  }
  const out: CalEvent[][] = [];
  for (const source of config.sources ?? []) {
    if (!source?.id || source.enabled === false) continue;
    const body = await os.fs
      .readTextFile(`${home}/.config/calendar/${source.id}.ics`)
      .catch(() => null);
    if (body !== null) out.push(parseIcs(body).events);
  }
  return out;
}

/** Everything coming up; an unreadable calendar is just skipped. */
async function upcoming(os: AppInterface, home: string): Promise<Upcoming[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86_400_000);
  const out: Upcoming[] = [];

  const calendars = (await Promise.all([mine(os, home), subscribed(os, home)])).flat();
  for (const events of calendars) {
    for (const series of groupByUid(events)) {
      if (series.master.status === "CANCELLED") continue;
      for (const instance of expandSeries(series, now, horizon)) {
        if (instance.end <= now) continue;
        out.push({
          at: instance.start,
          allDay: instance.allDay,
          title: instance.event.summary || "(no title)",
        });
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  // Daemonize, so the shell gets its prompt back and closing the terminal
  // (SIGHUP to the job's group) doesn't take the icon with it.
  if (args[0] !== "--bg") {
    await os.process.spawn("/ProgramFiles/upnext", ["--bg"]);
    await print(os, 1, "upnext: running in the top bar\n");
    return os.process.exit(0);
  }
  await os.process.setsid().catch(() => {});

  // Before addStatusItem: SIGHUP's default action is to terminate, so without
  // a handler the first accent change in Settings would kill the icon.
  await os.process.onSignal("SIGHUP", () => void paint());

  const home = (await os.process.env()).HOME ?? "/";
  let events: Upcoming[] = [];

  const timeOf = (at: Date) =>
    at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const menu = () => {
    const today = new Date();
    const rows = events.slice(0, 12).map((event, index) => ({
      id: String(index),
      label: `${
        event.allDay
          ? "All day"
          : event.at.toDateString() === today.toDateString()
            ? timeOf(event.at)
            : `${event.at.toLocaleDateString(undefined, { weekday: "short" })} ${timeOf(event.at)}`
      } · ${clamp(event.title, 40)}`,
      disabled: true,
    }));
    return [
      ...(rows.length ? rows : [{ id: "none", label: "Nothing coming up", disabled: true }]),
      { separator: true as const },
      { id: "open", label: "Open Calendar" },
      { id: "quit", label: "Quit" },
    ];
  };

  const label = (): string | undefined => {
    const next = events[0];
    if (!next) return undefined;
    const when = next.allDay ? "" : `${timeOf(next.at)} `;
    return clamp(`${when}${next.title}`, LABEL_MAX);
  };

  const item = await os.display.addStatusItem(
    { icon: ICON, title: "Up Next", menu: menu() },
    (id) => {
      if (id === "quit") return void os.process.exit(0); // the kernel frees the icon
      if (id === "open") return void os.process.spawn("/ProgramFiles/calendar");
    },
  );

  async function paint(): Promise<void> {
    events = await upcoming(os, home);
    await os.display.updateStatusItem(item, { label: label(), menu: menu() }).catch(() => {});
  }

  await paint();
  // The app rewrites the cache as it syncs, so follow the files rather than polling hard.
  await os.events.subscribe(["fs.changed"], (event) => {
    if (event.path.includes("/.config/calendar") || event.path.startsWith(`${CLOUD_DIR}/`)) {
      void paint();
    }
  });
  await os.timers.setInterval(() => void paint(), REFRESH_MS);
}
