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
import { dateKey, dueAt, openTodos, parseData, type Todo } from "./store.ts";

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
}

// ------------------------------------------------------- in the Calendar --

{
  const at = dueAt(todo("t", { date: "2026-10-17", time: "09:05" }))!;
  ok([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()], [2026, 9, 17, 9, 5], "a due time is a local wall clock");
  ok(dueAt(todo("t")), null, "no date, no due time");
  ok(dateKey(new Date(2026, 0, 5)), "2026-01-05", "days are stored zero-padded");

  const list = [
    todo("timed", { date: "2026-10-17", time: "14:00" }),
    todo("allday", { date: "2026-10-17" }),
    todo("someday"),
    todo("later", { date: "2026-11-02" }),
  ];
  const from = new Date(2026, 9, 12);
  const to = new Date(2026, 9, 19);
  const shown = todoOccurrences(list, from, to, "Todos");
  ok(shown.map((o) => o.todo!.id), ["timed", "allday"], "dated todos in the window, and only those");
  const [timed, allDay] = shown as [(typeof shown)[0], (typeof shown)[0]];
  ok([timed.allDay, timed.start.getHours(), (timed.end.getTime() - timed.start.getTime()) / 60_000], [false, 14, 30], "a timed todo sits at its time");
  ok([allDay.allDay, allDay.end.getDate()], [true, 18], "an undated-in-the-day todo is all day, ending at the next midnight");
  ok(timed.sourceId, "todo", "and they are marked as todos");
}

console.log(`todo store: ${count} checks passed`);
