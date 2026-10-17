// Self-check for the Projects app's pure parts: `node --import
// ./scripts/ts-resolve.js src/apps/projects/projects.check.ts` (or `pnpm check`).
//
// What it covers: the file can't be trusted (a hand-edited folder must not
// escape the root), the store's cloud-or-local choice and its queued writes,
// bringing in the Shortcuts app's spaces, the todo fields this app adds to the
// Todo app's list, and how a course's sessions are found in a timetable --
// "SOS" must find "SOS VO" and not "SOSE VO" -- and where the free time is.
import type { AppInterface } from "../../kernel/syscalls/api";
import { parseIcs } from "../calendar/parse.ts";
import { todoOccurrences } from "../calendar/todos.ts";
import { parseData as parseTodos } from "../todo/store.ts";
import {
  freeSlots,
  hasWord,
  isSession,
  nearMiss,
  nearMisses,
  sessionNow,
  sessionsOf,
  summarize,
  typeOf,
} from "./match.ts";
import { folderFor, fromShortcuts, labelOf, openProjects, parseData, readProjectHues, serialize } from "./store.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const fail = (code: string): Error => Object.assign(new Error(code), { code });

function fakeOs(files: Map<string, string>, cloud: boolean): AppInterface {
  const guard = (path: string): void => {
    if (!cloud && path.startsWith("/mnt/cloud")) throw fail("EACCES");
  };
  return {
    process: { env: () => Promise.resolve({ HOME: "/home/owner" }) },
    fs: {
      mkdir: async (path: string) => {
        guard(path);
        if (files.has(`dir:${path}`)) throw fail("EEXIST");
        files.set(`dir:${path}`, "");
      },
      readTextFile: async (path: string) => {
        guard(path);
        const body = files.get(path);
        if (body === undefined) throw fail("ENOENT");
        return body;
      },
      writeTextFile: async (path: string, body: string) => {
        guard(path);
        files.set(path, body);
      },
    },
  } as unknown as AppInterface;
}

// ------------------------------------------------------------- the file --

{
  const data = parseData(
    JSON.stringify({
      areas: [
        { id: "uni", name: " Uni ", hue: 290, rules: [{ days: [1, 9, 1], from: "09:00", to: "17:00" }, { days: [], from: "x" }] },
        { id: "uni", name: "Dup id", hue: 999 },
        { name: "" },
      ],
      projects: [
        { id: "sos", area: "uni", kind: "course", name: "Software Systems", code: "SOS", folder: "../../etc", shortcuts: [{ name: "x", url: "javascript:alert(1)" }, { name: "T", url: "https://tuwel.example.at/" }] },
        { id: "p2", area: "uni", kind: "project", name: "Thesis", code: "IGNORED", folder: "SOS Software Systems" },
        { id: "p3", area: "nowhere", name: "Orphan" },
        { id: "p4", area: "uni", name: "Same folder", folder: "sos software systems" },
      ],
      labels: { vo: "Vorlesung", "": "x" },
    }),
  );
  ok(data.areas.map((a) => [a.name, a.hue]), [["Uni", 290], ["Dup id", 279]], "areas are trimmed, nameless ones dropped, hues wrapped");
  ok(data.areas[1]!.id !== "uni", true, "a repeated id is replaced");
  ok(data.areas[0]!.rules, [{ days: [1], from: "09:00", to: "17:00" }], "rules are cleaned, broken ones dropped");
  ok(data.projects.map((p) => p.id), ["sos", "p2", "p4"], "a project in an area that isn't there is dropped");
  ok(data.projects[0]!.folder, "Software Systems", "a folder that would leave the root is replaced");
  ok(data.projects[1]!.folder, "SOS Software Systems", "a fine folder is kept");
  ok(data.projects[2]!.folder, "Same folder", "two projects never share a folder");
  ok(data.projects[0]!.shortcuts.map((s) => s.url), ["https://tuwel.example.at/"], "only https and mailto shortcuts survive");
  ok(data.projects[1]!.code, "", "only a course has a code");
  ok(data.projects[0]!.link, { calendar: "", skip: [], open: true, busy: true, end: true }, "a course gets a link, looking everywhere");
  ok(labelOf(data, "VO"), "Vorlesung", "a renamed session type");
  ok([labelOf(data, "UE"), labelOf(data, "XY"), labelOf(data, "")], ["Exercise", "XY", "Session"], "and the ones that weren't");
  ok(parseData(serialize(data)), data, "what is written reads back the same");
  ok(parseData("not json").areas, [], "a broken file is an empty one");
  ok(
    parseData(
      JSON.stringify({
        areas: [
          { name: "Work", calendar: "mine:abc123", openDuring: true },
          { name: "Bad", calendar: "../x", openDuring: true },
          { name: "Old" },
        ],
      }),
    ).areas.map((a) => [a.calendar, a.openDuring]),
    [["mine:abc123", true], ["", false], ["", false]],
    "an area's calendar is an id or nothing, and opens on its events only with one",
  );

  ok(
    parseData(
      JSON.stringify({
        areas: [
          { name: "A", icon: " http://example.com/logo.png " },
          { name: "B", icon: "javascript:alert(1)" },
          { name: "C", icon: "data:image/png;base64,AAAA" },
          { name: "D" },
        ],
      }),
    ).areas.map((a) => a.icon),
    ["https://example.com/logo.png", undefined, undefined, undefined],
    "an area's icon is an https link or nothing",
  );

  ok(folderFor("a/b: c?", new Set()), "a b c", "a folder name is one safe path segment");
  ok(folderFor("..", new Set()), "Project", "and never dots alone");
  ok(folderFor("Thesis", new Set(["thesis", "thesis 2"])), "Thesis 3", "and is never one already taken");
}

// ------------------------------------------------------------- the store --

{
  const files = new Map<string, string>();
  const app = await openProjects(fakeOs(files, true));
  ok([app.backing, app.path, app.root], ["cloud", "/mnt/cloud/projects/projects.json", "/mnt/cloud/projects"], "the owner's store is in the cloud");
  ok(app.data.areas.map((a) => a.name), ["Uni", "Work", "Private"], "a new store starts with three areas");
  const other = await openProjects(fakeOs(files, true));
  const uni = app.data.areas[0]!.id;
  await app.update((data) => void data.projects.push({ id: "a1", area: uni, kind: "project", name: "A", code: "", hue: 1, shortcuts: [], folder: "A" }));
  await other.update((data) => void (data.areas[0]!.name = "University"));
  const disk = parseData(files.get("/mnt/cloud/projects/projects.json")!);
  ok([disk.areas[0]!.name, disk.projects.map((p) => p.id)], ["University", ["a1"]], "two writers don't undo each other");
  ok(await app.reload(), true, "and each sees the other's change");
  const hues = await readProjectHues(fakeOs(files, true));
  ok([hues.get("a1"), hues.get(uni)], [1, 290], "the Calendar reads each project's and area's colour");

  const local = new Map<string, string>();
  const guest = await openProjects(fakeOs(local, false));
  ok([guest.backing, guest.path, guest.root], ["local", "/home/owner/.config/projects.json", "/home/owner/Projects"], "a refused mount keeps it in this browser");
  ok((await readProjectHues(fakeOs(local, false))).size, 3, "and the Calendar reads that copy (its three areas), without writing anything");
}

// -------------------------------------------------------- from Shortcuts --

{
  const body = JSON.stringify({
    spaces: [
      {
        id: "s1",
        name: "Uni",
        rules: [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" }],
        projects: [{ id: "p1", name: "SOS" }],
        shortcuts: [
          { name: "TUWEL", url: "https://tuwel.example.at/", project: "p1" },
          { name: "Mail", url: "https://mail.example.com/" },
        ],
      },
    ],
  });
  const { areas, projects } = fromShortcuts(body, new Set(["sos"]));
  ok(areas.map((a) => [a.name, a.rules.length]), [["Uni", 1]], "a space becomes an area, with its times");
  ok(projects.map((p) => [p.name, p.folder, p.shortcuts.map((s) => s.name)]), [["SOS", "SOS 2", ["TUWEL"]], ["Uni", "Uni", ["Mail"]]], "its projects keep their sites; loose sites get a project of their own");
  ok(fromShortcuts("{", new Set()), { areas: [], projects: [] }, "a broken Shortcuts file brings nothing");
}

// ---------------------------------------------------------- todo fields --

{
  const { todos } = parseTodos(
    JSON.stringify({
      todos: [
        { id: "g", title: "Goal", done: false, createdAt: 1, project: "sos", goal: true, parent: "x" },
        { id: "p", title: "Part", done: false, createdAt: 1, project: "sos", parent: "g" },
        { id: "q", title: "Bad refs", done: false, createdAt: 1, project: "../x", parent: 5, area: "../y" },
        { id: "a", title: "In an area", done: false, createdAt: 1, area: "priv" },
        { id: "b", title: "Both", done: false, createdAt: 1, project: "sos", area: "priv" },
      ],
    }),
  );
  ok(
    todos.map((t) => [t.project, t.area, t.goal, t.parent]),
    [["sos", undefined, true, undefined], ["sos", undefined, undefined, "g"], [undefined, undefined, undefined, undefined], [undefined, "priv", undefined, undefined], ["sos", undefined, undefined, undefined]],
    "the Todo app keeps project, area, goal and part; a goal is never a part, and a project wins over an area",
  );
}

// --------------------------------------------------------------- matching --

const ics = (events: string): string =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`;
const event = (uid: string, summary: string, start: string, end: string, extra = ""): string =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:${start}\r\nDTEND:${end}\r\n${extra}END:VEVENT\r\n`;

{
  ok([hasWord("SOS VO", "sos"), hasWord("SOSE VO", "SOS"), hasWord("(SOS)", "SOS"), hasWord("xSOS", "SOS")], [true, false, true, false], "a code is found as a whole word only");
  ok(hasWord("Fragestunde Software Systems", "software systems"), true, "a name of several words, ignoring case");
  ok([typeOf("SOS VO", "SOS"), typeOf("Lecture SOS UE (online)", "sos"), typeOf("SOS", "SOS"), typeOf("SOS Vorlesung", "SOS"), typeOf("Tutorium", "SOS")], ["VO", "UE", "", "", ""], "the type is the short word after the code");

  const { events } = parseIcs(
    ics(
      event("vo", "SOS VO", "20261005T090000", "20261005T110000", "RRULE:FREQ=WEEKLY;COUNT=12\r\nLOCATION:HS 1\r\n") +
        event("ue", "SOS UE", "20261007T140000", "20261007T160000", "RRULE:FREQ=WEEKLY;COUNT=10\r\n") +
        event("tut", "Tutorium", "20261023T120000", "20261023T130000", "DESCRIPTION:Fragen zu Software Systems\r\n") +
        event("x", "SOSE VO", "20261008T090000", "20261008T110000", "RRULE:FREQ=WEEKLY;COUNT=12\r\n") +
        event("vo", "SOS VO", "20261012T090000", "20261012T110000", "STATUS:CANCELLED\r\nRECURRENCE-ID:20261012T090000\r\n"),
    ),
  );
  ok(events.filter((e) => isSession(e, "SOS", "")).map((e) => e.uid), ["vo", "ue", "vo"], "by code: SOS's events (and the override), not SOSE's");
  ok(events.filter((e) => isSession(e, "", "Software Systems")).map((e) => e.uid), ["tut"], "by name: found in the notes");
  ok(nearMiss(events.find((e) => e.uid === "x")!, "SOS"), "SOSE", "a longer code is a near miss");
  ok(nearMisses(events, "SOS", "Software Systems"), [{ word: "SOSE", count: 1 }], "listed once, with how often");

  const from = new Date(2026, 9, 1);
  const to = new Date(2027, 1, 1);
  const sessions = sessionsOf(events, "SOS", "Software Systems", from, to);
  ok(sessions.length, 12 - 1 + 10 + 1, "every occurrence, a cancelled one left out");
  ok(sessionsOf(events, "SOS", "Software Systems", from, to, ["UE"]).some((s) => s.type === "UE"), false, "a skipped type is left out");
  const summary = summarize(sessions);
  ok(summary.map((s) => [s.type, s.count]), [["VO", 11], ["UE", 10], ["", 1]], "grouped by type, most first");
  ok(summary[0]!.slots[0], { type: "VO", weekday: 1, from: "09:00", to: "11:00", location: "HS 1", count: 11 }, "a lecture's weekly slot");
  ok(summary[2]!.slots, [], "a one-off has no slot");
  ok(sessionNow(sessions, new Date(2026, 9, 19, 8, 52))?.type, "VO", "a session is on from a few minutes before it starts");
  ok(sessionNow(sessions, new Date(2026, 9, 19, 11, 0)), undefined, "and over when it ends");
  ok(sessionsOf(events, "", "", from, to), [], "a course with no code or name has no sessions");
}

// -------------------------------------------------------------- free time --

{
  const day = new Date(2026, 9, 19);
  const at = (h: number, m = 0): number => new Date(2026, 9, 19, h, m).getTime();
  const before = new Date(2026, 9, 18, 12);
  const free = (busy: [number, number][], now = before) =>
    freeSlots(day, busy.map(([start, end]) => ({ start, end })), now).map((s) => [new Date(s.start).getHours(), new Date(s.end).getHours()]);
  ok(free([]), [[8, 20]], "an empty day is free from 8 to 20");
  ok(free([[at(9), at(11)], [at(10), at(12)], [at(13), at(14)]]), [[8, 9], [12, 13], [14, 20]], "overlapping busy time merges; gaps of an hour or more are free");
  ok(free([[at(8, 30), at(9)], [at(9, 30), at(19, 30)]]), [], "half hours aren't offered");
  ok(free([], new Date(2026, 9, 19, 15, 5)), [[15, 20]], "today starts now, at the next quarter hour");
  ok(freeSlots(day, [], new Date(2026, 9, 19, 15, 5))[0]!.start, at(15, 15), "rounded up");
  ok(free([], new Date(2026, 9, 20)), [], "a day gone has no free time");
}

// ----------------------------------------------- the Calendar's colours --

{
  const todo = { id: "t", title: "t", done: false, createdAt: 1, date: "2026-10-17", project: "sos" };
  const [plain] = todoOccurrences([todo], new Date(2026, 9, 17), new Date(2026, 9, 18), "Todos", new Date(2026, 9, 17));
  const [coloured] = todoOccurrences([todo], new Date(2026, 9, 17), new Date(2026, 9, 18), "Todos", new Date(2026, 9, 17), () => 290);
  ok([plain!.todoHue, coloured!.todoHue], [undefined, 290], "a todo is drawn in its project's colour when it has one");
}

console.log(`projects: ${count} checks passed`);
