// Self-check for store.ts: `node --import ./scripts/ts-resolve.js
// src/apps/todo/store.check.ts` (or `pnpm check`).
//
// What it covers is the part that is hard to see from inside either app: the
// Todo app and the Calendar both write one file, so two stores are opened
// over one fake filesystem and made to interleave. A third is opened over a
// filesystem that refuses /mnt/cloud, which is what everyone but the owner
// meets. The Calendar's view of the list, todoOccurrences, is checked last.
import type { AppInterface } from "../../kernel/syscalls/api";
import { todoOccurrences } from "../calendar/todos.ts";
import { describe } from "./commands.ts";
import {
  dateKey,
  deadlineAt,
  deadlineState,
  isForToday,
  openTodos,
  parseData,
  parseQuickAdd,
  plannedAt,
  plannedLate,
  type Todo,
} from "./store.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const fail = (code: string): Error => Object.assign(new Error(code), { code });

/** Enough of os.fs to open a store, with switches for the cloud and for writes. */
function fakeOs(files: Map<string, string>, cloud: boolean, opts: { failWrites?: boolean } = {}): AppInterface {
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
        if (opts.failWrites) throw fail("ENOSPC");
        files.set(path, body);
      },
    },
  } as unknown as AppInterface;
}

const CLOUD = "/mnt/cloud/todo/todos.json";
const LOCAL = "/home/owner/.config/todo.json";

const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({
  id,
  title: id,
  done: false,
  createdAt: 1,
  ...extra,
});

// ------------------------------------------------- the owner, two writers --

{
  const files = new Map<string, string>();
  // A list kept in this browser before signing in comes along to the cloud.
  files.set(LOCAL, JSON.stringify({ todos: [todo("before")] }));

  const app = await openTodos(fakeOs(files, true));
  ok(app.backing, "cloud", "the owner's list lives in the cloud");
  ok(app.path, CLOUD, "and that is the file to watch");
  ok(app.data.todos.map((t) => t.id), ["before"], "seeded from what this browser had");
  ok(parseData(files.get(CLOUD)!).todos.map((t) => t.id), ["before"], "and written there at once");

  const calendar = await openTodos(fakeOs(files, true));
  ok(calendar.path, app.path, "the Calendar opens the same file");

  // The app adds one; the Calendar, which never saw it, ticks the first.
  const added = todo("added");
  const adding = app.update((data) => void data.todos.push(structuredClone(added)));
  ok(app.data.todos.map((t) => t.id), ["before", "added"], "a change shows before it is written");
  await adding;
  await calendar.update((data) => {
    data.todos.find((t) => t.id === "before")!.done = true;
  });
  const onDisk = parseData(files.get(CLOUD)!).todos;
  ok(onDisk.map((t) => [t.id, t.done]), [["before", true], ["added", false]], "neither writer undoes the other");

  ok(await app.reload(), true, "the app notices the Calendar's tick");
  ok(app.data.todos[0]!.done, true, "and adopts it");
  ok(await app.reload(), false, "reading the same file again is no change");

  // Two quick changes queue rather than race.
  const one = app.update((data) => void (data.todos[1]!.title = "renamed"));
  const two = app.update((data) => void (data.todos[1]!.done = true));
  ok(app.data.todos[1], { ...app.data.todos[1], title: "renamed", done: true }, "both show at once");
  await Promise.all([one, two]);
  ok(parseData(files.get(CLOUD)!).todos[1]!.title, "renamed", "the first lands");
  ok(parseData(files.get(CLOUD)!).todos[1]!.done, true, "and the second on top of it");
}

// --------------------------------------------- everyone else, and failure --

{
  const files = new Map<string, string>();
  const guest = await openTodos(fakeOs(files, false));
  ok(guest.backing, "local", "a refused mount keeps the list in this browser");
  ok(guest.path, LOCAL, "in ~/.config");
  await guest.update((data) => void data.todos.push(todo("mine")));
  ok(parseData(files.get(LOCAL)!).todos.length, 1, "and writes it there");
  ok(files.has(CLOUD), false, "never touching the cloud");

  const full = await openTodos(fakeOs(files, false, { failWrites: true }));
  let threw = "";
  await full.update((data) => void data.todos.push(todo("lost"))).catch((e: { code: string }) => (threw = e.code));
  ok(threw, "ENOSPC", "a failed write is reported");
  ok(full.data.todos.map((t) => t.id), ["mine"], "and nothing unsaved stays on screen");
}

// --------------------------------------------------------- hand-edited --

{
  const data = parseData(
    JSON.stringify({
      sound: false,
      todos: [
        { id: "../../etc", title: "  path  ", date: "2026-10-17", time: "25:00" },
        { id: "dup", title: "a", date: "2026-02-31", time: "09:00" },
        { id: "dup", title: "b", done: true, doneAt: 5 },
        { id: "x", title: "" },
        "nonsense",
      ],
    }),
  );
  ok(data.sound, false, "the sound setting survives");
  ok(data.todos.length, 3, "untitled and malformed entries are dropped");
  ok(/^[a-z0-9]+$/.test(data.todos[0]!.id), true, "an id that could be a path is replaced");
  ok(data.todos[0]!.title, "path", "titles are trimmed");
  ok([data.todos[0]!.date, data.todos[0]!.time], ["2026-10-17", undefined], "an impossible time is dropped");
  ok([data.todos[1]!.date, data.todos[1]!.time], [undefined, undefined], "a day that doesn't exist takes its time with it");
  ok(data.todos[1]!.id !== data.todos[2]!.id, true, "duplicate ids are split");
  ok(data.todos[2]!.doneAt, 5, "a finished todo keeps when");
  ok(parseData("not json"), { todos: [], sound: true }, "garbage is an empty list");

  const [planned, untimed, due, noDay] = parseData(
    JSON.stringify({
      todos: [
        { id: "a", title: "a", date: "2026-10-17", time: "09:00", minutes: 90, deadline: "2026-10-20", deadlineTime: "17:00" },
        { id: "b", title: "b", date: "2026-10-17", minutes: 90 },
        { id: "c", title: "c", deadline: "2026-10-20", deadlineTime: "7pm", minutes: -5 },
        { id: "d", title: "d", deadlineTime: "17:00", minutes: 99999, time: "09:00" },
      ],
    }),
  ).todos as [Todo, Todo, Todo, Todo];
  ok([planned.minutes, planned.deadline, planned.deadlineTime], [90, "2026-10-20", "17:00"], "a plan's length and a deadline are kept");
  ok(untimed.minutes, undefined, "a length needs a time to start from");
  ok([due.deadline, due.deadlineTime, due.minutes], ["2026-10-20", undefined, undefined], "a deadline's bad time is dropped, and a stray length");
  ok([noDay.deadlineTime, noDay.time, noDay.minutes], [undefined, undefined, undefined], "times with no day are dropped");
  const long = parseData(JSON.stringify({ todos: [{ id: "e", title: "e", date: "2026-10-17", time: "09:00", minutes: 99999 }] }));
  ok(long.todos[0]!.minutes, 1440, "a length is capped at a day");
}

// ------------------------------------------------------ plan and deadline --

{
  // Saturday 17 October 2026, mid-morning.
  const now = new Date(2026, 9, 17, 10, 30);
  const today = dateKey(now);

  const at = plannedAt(todo("t", { date: "2026-10-17", time: "09:05" }))!;
  ok([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()], [2026, 9, 17, 9, 5], "a planned time is a local wall clock");
  ok(plannedAt(todo("t")), null, "no date, no plan");
  ok(deadlineAt(todo("t", { deadline: "2026-10-20", deadlineTime: "17:00" }))!.getHours(), 17, "a deadline at its time");
  ok(dateKey(new Date(2026, 0, 5)), "2026-01-05", "days are stored zero-padded");

  const state = (extra: Partial<Todo>) => deadlineState(todo("t", extra), now);
  ok(state({}), null, "no deadline, nothing to say");
  ok(state({ deadline: "2026-10-17" }), "soon", "due today with no time isn't late until the day is over");
  ok(state({ deadline: "2026-10-17", deadlineTime: "10:00" }), "late", "due earlier today, at a time, is late");
  ok(state({ deadline: "2026-10-17", deadlineTime: "18:00" }), "soon", "due later today is soon");
  ok(state({ deadline: "2026-10-16" }), "late", "due yesterday is late");
  ok(state({ deadline: "2026-10-20" }), "soon", "three days off is soon");
  ok(state({ deadline: "2026-10-21" }), "later", "four days off is later");
  ok(state({ deadline: "2026-10-16", done: true }), null, "a done todo's deadline is no longer news");

  const late = (extra: Partial<Todo>) => plannedLate(todo("t", extra));
  ok(late({ date: "2026-10-21", deadline: "2026-10-20" }), true, "planned the day after it's due");
  ok(late({ date: "2026-10-20", deadline: "2026-10-20" }), false, "planned on the day it's due is fine");
  ok(late({ date: "2026-10-20", time: "16:00", minutes: 120, deadline: "2026-10-20", deadlineTime: "17:00" }), true, "a plan that runs past the deadline's time");
  ok(late({ date: "2026-10-20", time: "15:00", minutes: 120, deadline: "2026-10-20", deadlineTime: "17:00" }), false, "and one that ends on it");
  ok(late({ date: "2026-10-20", time: "18:00", deadline: "2026-10-20" }), false, "a deadline with no time runs all day");
  ok(late({ date: "2026-10-21" }), false, "no deadline, never late");

  ok(isForToday(todo("t", { date: "2026-10-12" }), today), true, "a missed plan carries over to today");
  ok(isForToday(todo("t", { deadline: today }), today), true, "so does a deadline today");
  ok(isForToday(todo("t", { date: "2026-10-18", deadline: "2026-10-16" }), today), false, "a past deadline alone doesn't");
}

// ------------------------------------------------------- in the Calendar --

{
  const now = new Date(2026, 9, 17, 10, 30);
  const list = [
    todo("timed", { date: "2026-10-17", time: "14:00" }),
    todo("allday", { date: "2026-10-17" }),
    todo("someday"),
    todo("later", { date: "2026-11-02" }),
  ];
  const from = new Date(2026, 9, 12);
  const to = new Date(2026, 9, 19);
  const shown = todoOccurrences(list, from, to, "Todos", now);
  ok(shown.map((o) => o.todo!.id), ["timed", "allday"], "dated todos in the window, and only those");
  const [timed, allDay] = shown as [(typeof shown)[0], (typeof shown)[0]];
  ok([timed.allDay, timed.start.getHours(), (timed.end.getTime() - timed.start.getTime()) / 60_000], [false, 14, 30], "a timed todo sits at its time");
  ok([allDay.allDay, allDay.end.getDate()], [true, 18], "an undated-in-the-day todo is all day, ending at the next midnight");
  ok([timed.sourceId, timed.todoPart], ["todo", "plan"], "and they are marked as todos, and as plans");

  const parts = (one: Todo) =>
    todoOccurrences([one], from, to, "Todos", now).map((o) => [o.todoPart, o.key, o.start.getDate(), o.allDay]);
  const [long] = todoOccurrences([todo("long", { date: "2026-10-17", time: "09:00", minutes: 120 })], from, to, "Todos", now);
  ok(long!.end.getHours(), 11, "a plan with a length takes it up");
  ok(
    parts(todo("m", { date: "2026-10-14", time: "09:00" })),
    [["missed", "m", 14, false], ["carried", "m:today", 17, true]],
    "a missed plan stays where it was and carries over to today, all day",
  );
  ok(parts(todo("m", { date: "2026-10-14", done: true })), [["plan", "m", 14, true]], "a done one doesn't carry over");
  ok(
    parts(todo("d", { deadline: "2026-10-16", deadlineTime: "17:00" })),
    [["deadline", "d:due", 16, false]],
    "a timed deadline sits at its time",
  );
  ok(parts(todo("d", { deadline: "2026-10-18" })), [["deadline", "d:due", 18, true]], "a deadline with no time is all day");
  ok(parts(todo("d", { deadline: "2026-10-18", done: true })), [], "a done todo's deadline isn't drawn");
  ok(
    parts(todo("b", { date: "2026-10-17", deadline: "2026-10-18" })).map((p) => p[0]),
    ["plan", "deadline"],
    "a todo with both puts both on the calendar",
  );
}

// ---- quick add (Spotlight's "New todo"): Saturday 17 October 2026, 10:00
{
  const now = new Date(2026, 9, 17, 10, 0);
  const q = (line: string) => parseQuickAdd(line, now);
  ok(q("buy milk"), { title: "buy milk" }, "nothing understood: no plan");
  ok(q("buy milk tomorrow"), { title: "buy milk", date: "2026-10-18" }, "tomorrow");
  ok(q("Today: water plants"), { title: "Today: water plants" }, "a word with other punctuation stays");
  ok(q("water plants today."), { title: "water plants", date: "2026-10-17" }, "trailing punctuation is fine");
  ok(q("call mum fri 14:00 for 30m"), { title: "call mum", date: "2026-10-23", time: "14:00", minutes: 30 }, "weekday, time, length");
  ok(q("standup sat at 9am"), { title: "standup", date: "2026-10-17", time: "09:00" }, "today's weekday is today; 9am");
  ok(q("15:00 dentist"), { title: "dentist", date: "2026-10-17", time: "15:00" }, "a time alone is today");
  ok(q("gym 6pm for 1h30"), { title: "gym", date: "2026-10-17", time: "18:00", minutes: 90 }, "pm and an hour and a half");
  ok(q("read for 30m"), { title: "read for 30m" }, "a length with no time stays in the title");
  ok(q("essay due 3/11 17:00"), { title: "essay", deadline: "2026-11-03", deadlineTime: "17:00" }, "a deadline, day first");
  ok(q("essay due fri"), { title: "essay", deadline: "2026-10-23" }, "a deadline on a weekday");
  ok(q("taxes due 1/4"), { title: "taxes", deadline: "2027-04-01" }, "a day gone by this year is next year's");
  ok(q("report mon due wed at 12:00"), { title: "report", date: "2026-10-19", deadline: "2026-10-21", deadlineTime: "12:00" }, "plan and deadline");
  ok(q("pay rent 2026-11-01"), { title: "pay rent", date: "2026-11-01" }, "an ISO day");
  ok(q("due diligence"), { title: "due diligence" }, "due without a when is a word");
  ok(q('call "Sun" office'), { title: "call Sun office" }, "quotes keep a word");
  ok(q("fri sat"), { title: "sat", date: "2026-10-23" }, "only one plan day; the second stays");
  ok(q("31/2 party"), { title: "31/2 party" }, "a day that doesn't exist is text");
  ok(q("25:00 tomorrow"), { title: "25:00", date: "2026-10-18" }, "a time that doesn't exist is text");
  ok(q("tomorrow"), { title: "", date: "2026-10-18" }, "only a when: no title (the command asks for one)");

  ok(describe({}, now), "no plan", "describe: no plan");
  ok(describe({ date: "2026-10-17", time: "14:00", minutes: 90 }, now), "today 14:00 for 1h30", "describe: today, timed");
  ok(describe({ date: "2026-10-23", deadline: "2026-11-03" }, now), "Fri · due 3 Nov", "describe: weekday and a far deadline");
}

console.log(`todo store: ${count} checks passed`);
