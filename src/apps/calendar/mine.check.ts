// Self-check for mine.ts, write.ts and draft.ts: `node --import
// ./scripts/ts-resolve.js src/apps/calendar/mine.check.ts` (or `pnpm check`).
//
// Two things are hard to see from inside the app. That a calendar written by
// write.ts reads back through parse.ts as the same calendar -- the store's
// read-modify-write depends on it. And where the files go: two stores over
// one fake filesystem stand in for two browsers signed in as the owner, and a
// third over a filesystem that refuses /mnt/cloud is everyone else.
import type { AppInterface } from "../../kernel/syscalls/api";
import { buildEvent, repeatOf, type Draft } from "./draft.ts";
import { expandSeries, groupByUid } from "./expand.ts";
import { openMine, readCalendar, serializeCalendar, type OwnCalendar } from "./mine.ts";
import { parseIcs } from "./parse.ts";
import { fold, writeIcs } from "./write.ts";
import { naive } from "./zone.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

// -- writing ----------------------------------------------------------------

const draft = (over: Partial<Draft> = {}): Draft => ({
  summary: "Stand-up; daily, short",
  location: "Room 4",
  description: "Line one\nLine two \\ with a backslash",
  url: "https://example.com/meet",
  allDay: false,
  start: naive(2026, 10, 6, 10, 0),
  end: naive(2026, 10, 6, 10, 30),
  repeat: null,
  ...over,
});

const timed = buildEvent(draft({ repeat: { freq: "WEEKLY", interval: 2, until: naive(2026, 12, 15) } }), {
  uid: "abc",
  stamp: Date.UTC(2026, 9, 1),
  zone: "Europe/Amsterdam",
});
const allDay = buildEvent(
  draft({ summary: "Holiday", allDay: true, start: naive(2026, 12, 24), end: naive(2026, 12, 27), url: "" }),
  { uid: "def", stamp: Date.UTC(2026, 9, 1), zone: "Europe/Amsterdam" },
);

const text = writeIcs({ name: "Work, mostly", hue: 210 }, [timed, allDay]);
const back = parseIcs(text);
ok(back.name, "Work, mostly", "the calendar's name survives escaping");
ok(back.warnings, [], "and the file reads back without complaint");
ok(back.events.length, 2, "both events come back");

const [t, d] = back.events;
ok(
  [t!.summary, t!.location, t!.description, t!.url],
  [timed.summary, timed.location, timed.description, timed.url],
  "text with ; , \\ and newlines round-trips",
);
ok([t!.start, t!.durationMs, t!.zone], [timed.start, timed.durationMs, "Europe/Amsterdam"], "a timed event keeps its wall clock and zone");
ok([t!.rrule!.freq, t!.rrule!.interval, t!.rrule!.until], ["WEEKLY", 2, timed.rrule!.until], "and its repeat");
ok(t!.stamp, Date.UTC(2026, 9, 1), "DTSTAMP is written and read back");
ok([d!.allDay, d!.start, d!.durationMs], [true, naive(2026, 12, 24), 3 * 86_400_000], "an all-day event keeps its days, end exclusive");

const repeat = repeatOf(t!);
ok(repeat, { freq: "WEEKLY", interval: 2, until: naive(2026, 12, 15) }, "the editor reads back what it wrote");

// The last fortnightly Tuesday on or before Dec 15 is Dec 15 itself: UNTIL is inclusive.
const dates = expandSeries(groupByUid([t!])[0]!, new Date(2026, 9, 1), new Date(2027, 0, 31)).map((i) =>
  i.start.toISOString().slice(0, 10),
);
ok(dates.at(-1), "2026-12-15", "the series stops on its last day, not the day before");

ok(serializeCalendar(readCalendar("work", text)).includes("X-CALENDAR-HUE:210"), true, "the colour travels in the file");
ok(readCalendar("work", text).hue, 210, "and is read back");
ok(writeIcs({ name: "x" }, [timed]) === writeIcs({ name: "x" }, [parseIcs(writeIcs({ name: "x" }, [timed])).events[0]!]), true,
  "writing what was read gives the same bytes, so a no-op save is skipped");

const long = fold(`SUMMARY:${"é".repeat(60)}`);
ok(long.split("\r\n ").every((line, i) => new TextEncoder().encode(line).length <= (i ? 74 : 75)), true,
  "long lines fold within 75 octets");
ok(long.split("\r\n ").join(""), `SUMMARY:${"é".repeat(60)}`, "without splitting a character");

// Moving one occurrence of a series moves the whole series by as much.
const moved = buildEvent(
  draft({ start: naive(2026, 10, 20, 11, 0), end: naive(2026, 10, 20, 11, 30), repeat: { freq: "WEEKLY", interval: 2, until: null } }),
  { uid: "abc", stamp: 1, zone: null, base: { ...t!, zone: null }, occurrence: new Date(2026, 9, 20, 10, 0) },
);
ok(moved.start, naive(2026, 10, 6, 11, 0), "an hour later on the third Tuesday is an hour later from the first");
ok(moved.sequence, t!.sequence + 1, "and an edit bumps SEQUENCE");

// -- storing ----------------------------------------------------------------

const fail = (code: string): Error => Object.assign(new Error(code), { code });
let clock = 1000;

/**
 * Enough of os.fs to open a store, with a switch for the cloud mount. Each
 * file's modification time sits beside it in the map under "stamp:<path>",
 * so every fake browser over one map sees the server's own clock.
 */
function fakeOs(files: Map<string, string>, cloud: boolean): AppInterface {
  const guard = (path: string): void => {
    if (!cloud && path.startsWith("/mnt/cloud")) throw fail("EACCES");
  };
  return {
    process: { env: () => Promise.resolve({ HOME: "/home/owner" }) },
    fs: {
      mkdir: (path: string) => {
        guard(path);
        if (files.has(`dir:${path}`)) return Promise.reject(fail("EEXIST"));
        files.set(`dir:${path}`, "");
        return Promise.resolve();
      },
      readdir: (path: string) => {
        guard(path);
        if (!files.has(`dir:${path}`)) return Promise.reject(fail("ENOENT"));
        const entries = [...files.keys()]
          .filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
          .map((key) => ({
            name: key.slice(path.length + 1),
            kind: "file",
            modifiedAt: Number(files.get(`stamp:${key}`) ?? 0),
          }));
        return Promise.resolve(entries);
      },
      readTextFile: (path: string) => {
        guard(path);
        const body = files.get(path);
        return body === undefined ? Promise.reject(fail("ENOENT")) : Promise.resolve(body);
      },
      writeTextFile: (path: string, body: string) => {
        guard(path);
        files.set(path, body);
        files.set(`stamp:${path}`, String(++clock));
        return Promise.resolve();
      },
      unlink: (path: string) => {
        guard(path);
        files.delete(path);
        return Promise.resolve();
      },
    },
  } as unknown as AppInterface;
}

const CLOUD = "/mnt/cloud/calendar/mine";
const LOCAL = "/home/owner/.config/calendar/mine";
const icsIn = (files: Map<string, string>, dir: string): string[] =>
  [...files.keys()].filter((key) => key.startsWith(`${dir}/`) && key.endsWith(".ics")).sort();

const calendar = (id: string, name: string): OwnCalendar => ({ id, name, hidden: false, events: [] });

// Everyone else: the mount refuses, so the calendars stay in this browser.
const alone = new Map<string, string>();
const visitor = await openMine(fakeOs(alone, false));
ok(visitor.backing, "local", "a refusing mount leaves your calendars here");
await visitor.put(calendar("home", "Home"));
await visitor.update("home", (c) => c.events.push(allDay));
ok(icsIn(alone, LOCAL), [`${LOCAL}/home.ics`], "one .ics per calendar, in ~/.config/calendar/mine");
ok(readCalendar("home", alone.get(`${LOCAL}/home.ics`)!).events.length, 1, "holding its events");

// The owner, signing in for the first time: what this browser had goes up.
const server = new Map(alone);
const a = await openMine(fakeOs(server, true));
ok(a.backing, "cloud", "the mount answers");
ok(icsIn(server, CLOUD), [`${CLOUD}/home.ics`], "and an empty cloud folder is seeded from this browser");
ok(a.calendars.map((c) => c.name), ["Home"], "which is what the app now shows");

// A second browser over the same server, editing the same calendar.
const b = await openMine(fakeOs(server, true));
await a.update("home", (c) => c.events.push(timed));
await b.update("home", (c) => c.events.push({ ...timed, uid: "from-b" }));
ok(readCalendar("home", server.get(`${CLOUD}/home.ics`)!).events.map((e) => e.uid), ["def", "abc", "from-b"],
  "an edit is a read-modify-write: b's event doesn't drop a's");
ok(await a.reload(), true, "a's tick notices b's edit");
ok(a.calendars[0]!.events.length, 3, "and adopts it");
ok(await a.reload(), false, "and finds nothing new the next time");

await b.put(calendar("work", "Work"));
await b.remove("home");
ok(await a.reload(), true, "a notices a calendar made and one deleted elsewhere");
ok(a.calendars.map((c) => c.id), ["work"], "and follows both");

let refused = "";
await a.update("gone", () => {}).catch((error: { code?: string }) => (refused = error.code ?? ""));
ok(refused, "ENOENT", "editing a calendar that was deleted elsewhere is refused, not recreated");

console.log(`calendar/mine: ${count} checks passed`);
