// What the Todo app keeps on disk, and what the Calendar reads to draw it:
//
//   /mnt/cloud/todo/todos.json   the list, on the server, for whoever that
//                                mount lets in
//   ~/.config/todo.json          the list in this browser, for everyone else
//
// One file, never both. Whether the cloud mount will have us is decided once,
// on open, by trying it: a refusal is a storage answer, not an answer about
// who is running the app, so nothing here asks who that is. The Calendar and
// the Todo app open the same way and so always agree on which file it is.
//
// Three processes write the file -- the Todo app, the Calendar when a todo is
// ticked off there, and the Projects app, which files todos under projects
// and goals (`project`, `goal`, `parent`) or straight under an area (`area`)
// -- so every change is a read-modify-write of the latest copy rather than a
// save of whatever this process last saw. Without that, ticking a todo in the
// Calendar and then renaming another in the Todo app would quietly untick the
// first.
//
// Nothing here trusts the file: someone may have edited it by hand.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir } from "../../utils/settings";

const CLOUD_DIR = "/mnt/cloud/todo";
const CLOUD_FILE = `${CLOUD_DIR}/todos.json`;

export const MAX_TODOS = 1000;
export const MAX_TITLE = 200;
export const MAX_NOTES = 2000;
/** A plan can't be longer than its day. */
export const MAX_MINUTES = 1440;
/** A deadline this many days off or closer is "soon". */
export const SOON_DAYS = 3;

/**
 * A todo has two "when"s, and they mean different things:
 *
 *   date, time, minutes        the plan: when you mean to do it. It slips,
 *                              and that's fine -- a missed plan just carries
 *                              over to today.
 *   deadline, deadlineTime     when it has to be done by. Passing this is
 *                              the only thing the apps draw in red.
 *
 * The plan kept the names `date` and `time` from before deadlines existed,
 * so lists written then still read the same.
 */
export interface Todo {
  id: string;
  title: string;
  done: boolean;
  /** The day you plan to do it, a local "YYYY-MM-DD". No date: someday. */
  date?: string;
  /** The planned local wall clock, "HH:MM". Only ever alongside a date. */
  time?: string;
  /** How long the plan takes. Only ever alongside a time. */
  minutes?: number;
  /** The day it is due, a local "YYYY-MM-DD". */
  deadline?: string;
  /** Due by this local wall clock, "HH:MM". Only alongside a deadline. */
  deadlineTime?: string;
  notes?: string;
  createdAt: number;
  doneAt?: number;
  /**
   * The Projects app's project this belongs to, by id. A todo made here has
   * none; one whose project was deleted keeps a stale id, read as none.
   */
  project?: string;
  /**
   * The Projects app's area this is filed straight under, when it isn't in
   * a project ("Private", with no project of its own). Never alongside a project.
   */
  area?: string;
  /** A goal: a larger piece of work, whose deadline its parts are planned towards. */
  goal?: boolean;
  /** The goal (another todo's id) this is a part of. */
  parent?: string;
}

export interface Data {
  todos: Todo[];
  /** The pling on finishing one. Shared, so muting it holds everywhere. */
  sound: boolean;
}

export type Backing = "cloud" | "local";

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ----------------------------------------------------------------- dates --

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local day `at` falls on, as stored. */
export function dateKey(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Local midnight of a stored day, or null if it isn't one. */
export function parseDate(key: string): Date | null {
  const m = DATE.exec(key);
  if (!m) return null;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // new Date rolls Feb 31 over into March; a day that rolled isn't a day.
  return dateKey(day) === key ? day : null;
}

export const isTime = (value: string): boolean => TIME.test(value);

/** A stored day, at a stored time if there is one; otherwise its midnight. */
function moment(date: string | undefined, time: string | undefined): Date | null {
  const day = date ? parseDate(date) : null;
  if (!day) return null;
  if (!time) return day;
  const [h, m] = time.split(":").map(Number);
  // Built from parts, so a DST change that day lands on the right wall clock.
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** When you plan to do it: the day's midnight, or that day at its time. */
export const plannedAt = (todo: Todo): Date | null => moment(todo.date, todo.time);

/** When it is due: the deadline day's midnight, or that day at its time. */
export const deadlineAt = (todo: Todo): Date | null => moment(todo.deadline, todo.deadlineTime);

export const addDays = (at: Date, days: number): Date =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);

/** Calendar days from `from` to `to`, by date rather than by elapsed time. */
export function daysBetween(from: Date, to: Date): number {
  const midnight = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/**
 * How pressing a deadline is, `now`: "late" once it has passed, "soon"
 * within SOON_DAYS (its own day included), "later" before that. Null with no
 * deadline, or once the todo is done -- a met deadline is no longer news.
 *
 * A deadline with no time runs to the end of its day, so it is only late
 * the day after.
 */
export function deadlineState(todo: Todo, now: Date): "late" | "soon" | "later" | null {
  const at = deadlineAt(todo);
  if (!at || todo.done) return null;
  const days = daysBetween(now, at);
  if (todo.deadlineTime ? at <= now : days < 0) return "late";
  return days <= SOON_DAYS ? "soon" : "later";
}

/**
 * The plan won't be done before the deadline: it ends after it, or, where
 * either has no time, it is on a later day.
 */
export function plannedLate(todo: Todo): boolean {
  const plan = plannedAt(todo);
  const due = deadlineAt(todo);
  if (!plan || !due) return false;
  if (!todo.time || !todo.deadlineTime) return todo.date! > todo.deadline!;
  return plan.getTime() + (todo.minutes ?? 0) * 60_000 > due.getTime();
}

/**
 * On today's list: planned for today or a day already gone (a missed plan
 * carries over), or due today. Shared by the Todo app's Today group and the
 * Calendar's count of it.
 */
export function isForToday(todo: Todo, today: string): boolean {
  return Boolean((todo.date && todo.date <= today) || todo.deadline === today);
}

// ------------------------------------------------------------- quick add --

/** What a line typed in one go means: the title, and the whens it named. */
export interface QuickAdd {
  title: string;
  date?: string;
  time?: string;
  minutes?: number;
  deadline?: string;
  deadlineTime?: string;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** A day word, as a stored day: today, tomorrow, a weekday (the next one, today counting), d/m or YYYY-MM-DD. */
function dayWord(word: string, now: Date): string | null {
  if (word === "today" || word === "tod") return dateKey(now);
  if (word === "tomorrow" || word === "tmr" || word === "tmrw" || word === "tom") {
    return dateKey(addDays(now, 1));
  }
  if (word in WEEKDAYS) return dateKey(addDays(now, (WEEKDAYS[word]! - now.getDay() + 7) % 7));
  if (parseDate(word)) return word;
  const dm = /^(\d{1,2})\/(\d{1,2})$/.exec(word);
  if (dm) {
    // Day first. This year's, unless that has gone by: then next year's.
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
      const key = `${year}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}`;
      if (parseDate(key) && key >= dateKey(now)) return key;
    }
  }
  return null;
}

/** A time of day: 14:00, 9:30, 2pm, 2:30pm. */
function timeWord(word: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word);
  if (!m || (!m[2] && !m[3])) return null; // a bare number is not a time
  let hours = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  if (m[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (m[3] === "pm" ? 12 : 0);
  }
  const time = `${pad(hours)}:${pad(minutes)}`;
  return isTime(time) ? time : null;
}

/** A length: 30m, 45min, 2h, 1h30, 1h30m. */
function lengthWord(word: string): number | null {
  const m = /^(?:(\d+)h(?:(\d{1,2})m?)?|(\d+)(?:m|min|mins))$/.exec(word);
  if (!m) return null;
  const minutes = m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] ?? 0);
  return minutes > 0 ? Math.min(minutes, MAX_MINUTES) : null;
}

/**
 * Read the whens out of a line, the way Spotlight's "New todo" takes it:
 *
 *   buy milk tomorrow              planned tomorrow
 *   call mum fri 14:00 for 30m     planned Friday at 14:00, for half an hour
 *   essay due 3/11 17:00           due on 3 November at 17:00, no plan
 *   15:00 dentist                  a time alone is today, as in the app
 *
 * The words it understands come out of the title; anything in "quotes" is
 * left alone ("call "Sun" office" keeps its Sun). Nothing understood: no
 * plan. Each when is taken once; a second one stays in the title.
 */
export function parseQuickAdd(line: string, now: Date): QuickAdd {
  const tokens = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) =>
    m[1] !== undefined ? { text: m[1], literal: true } : { text: m[2]!, literal: false },
  );
  const word = (i: number): string =>
    tokens[i] && !tokens[i]!.literal ? tokens[i]!.text.toLowerCase().replace(/[,.;!?]+$/, "") : "";
  const out: Omit<QuickAdd, "title"> = {};
  const title: string[] = [];
  /** Where "for <length>" was, to put it back if no time comes to go with it. */
  let lengthAt: { index: number; words: string[] } | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const w = word(i);
    if (w === "due" && !out.deadline) {
      let j = i + 1;
      const day = dayWord(word(j), now);
      if (day) j++;
      if (word(j) === "at" && timeWord(word(j + 1))) j++;
      const time = timeWord(word(j));
      if (time) j++;
      if (day || time) {
        out.deadline = day ?? dateKey(now);
        if (time) out.deadlineTime = time;
        i = j - 1;
        continue;
      }
    }
    if (w === "for" && out.minutes === undefined) {
      const minutes = lengthWord(word(i + 1));
      if (minutes) {
        out.minutes = minutes;
        lengthAt = { index: title.length, words: [tokens[i]!.text, tokens[i + 1]!.text] };
        i++;
        continue;
      }
    }
    if (w === "at" && !out.time) {
      const time = timeWord(word(i + 1));
      if (time) {
        out.time = time;
        i++;
        continue;
      }
    }
    if (!out.date) {
      const day = dayWord(w, now);
      if (day) {
        out.date = day;
        continue;
      }
    }
    if (!out.time) {
      const time = timeWord(w);
      if (time) {
        out.time = time;
        continue;
      }
    }
    title.push(tokens[i]!.text);
  }

  // As in the app: a time with no day means today, and a length needs a
  // time (without one, "read for 30m" is just what it says).
  if (out.time && !out.date) out.date = dateKey(now);
  if (!out.time && lengthAt) {
    delete out.minutes;
    title.splice(lengthAt.index, 0, ...lengthAt.words);
  }
  const { date, time, minutes, deadline, deadlineTime } = out;
  return {
    title: title.join(" ").trim().slice(0, MAX_TITLE),
    ...(date && { date }),
    ...(time && { time }),
    ...(minutes && { minutes }),
    ...(deadline && { deadline }),
    ...(deadlineTime && { deadlineTime }),
  };
}

// ------------------------------------------------------------ validation --

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function cleanTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Todo>;
  const title = text(given.title).slice(0, MAX_TITLE);
  if (!title) return null;
  const date = parseDate(text(given.date)) ? text(given.date) : "";
  const time = date && isTime(text(given.time)) ? text(given.time) : "";
  const minutes =
    time && Number.isInteger(given.minutes) && given.minutes! > 0
      ? Math.min(given.minutes!, MAX_MINUTES)
      : 0;
  const deadline = parseDate(text(given.deadline)) ? text(given.deadline) : "";
  const deadlineTime = deadline && isTime(text(given.deadlineTime)) ? text(given.deadlineTime) : "";
  const notes = text(given.notes).slice(0, MAX_NOTES);
  const done = given.done === true;
  const ref = (value: unknown): string => (/^[a-z0-9]{1,16}$/i.test(text(value)) ? text(value) : "");
  const project = ref(given.project);
  const area = project ? "" : ref(given.area);
  const parent = ref(given.parent);
  return {
    id: /^[a-z0-9]{1,16}$/i.test(text(given.id)) ? text(given.id) : newId(),
    title,
    done,
    ...(date && { date }),
    ...(time && { time }),
    ...(minutes && { minutes }),
    ...(deadline && { deadline }),
    ...(deadlineTime && { deadlineTime }),
    ...(notes && { notes }),
    createdAt: typeof given.createdAt === "number" ? given.createdAt : 0,
    ...(done && typeof given.doneAt === "number" && { doneAt: given.doneAt }),
    ...(project && { project }),
    ...(area && { area }),
    ...(given.goal === true && { goal: true }),
    // A goal is never a part of another one: one level, on purpose.
    ...(parent && given.goal !== true && { parent }),
  };
}

export function parseData(body: string | null): Data {
  let raw: Partial<Data> = {};
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (parsed && typeof parsed === "object") raw = parsed as Partial<Data>;
  } catch {
    /* no file yet, or not JSON: start empty */
  }
  const todos: Todo[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.todos) ? raw.todos : []) {
    const todo = cleanTodo(entry);
    if (!todo) continue;
    while (seen.has(todo.id)) todo.id = newId();
    seen.add(todo.id);
    todos.push(todo);
    if (todos.length >= MAX_TODOS) break;
  }
  return { todos, sound: raw.sound !== false };
}

export const serialize = (data: Data): string =>
  `${JSON.stringify({ todos: data.todos, sound: data.sound }, null, 2)}\n`;

// ----------------------------------------------------------------- store --

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "ERROR";

/** Null for "not there"; anything else is a real failure and is thrown. */
async function readText(os: AppInterface, path: string): Promise<string | null> {
  try {
    return await os.fs.readTextFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** The sentence a failed save shows. Only the cloud's own wording names it. */
export function saveProblem(error: unknown, backing: Backing): string {
  if (codeOf(error) === "ENOSPC") {
    return backing === "cloud" ? "There's no room left in cloud storage." : "There's no room left.";
  }
  if (backing === "cloud" && codeOf(error) === "EACCES") return "Signed out — couldn't save.";
  return "Couldn't save. Try again.";
}

export interface TodoStore {
  /** The latest copy this process has seen. Replaced, never mutated in place. */
  readonly data: Data;
  readonly backing: Backing;
  /** The file itself: fs.changed for this path means someone wrote it. */
  readonly path: string;
  /** Re-read the file. True when it differs from what this process had. */
  reload(): Promise<boolean>;
  /**
   * Apply `change` to the latest copy on disk and write it back. Changes
   * queue behind one another, so two quick ticks never race. `data` reflects
   * the change at once; a failed write rejects and `data` is re-read.
   *
   * `change` runs twice -- once on what is on screen, once on what is on
   * disk -- so it must be deterministic: make ids and timestamps outside it.
   */
  update(change: (data: Data) => void): Promise<void>;
}

export async function openTodos(os: AppInterface): Promise<TodoStore> {
  const localFile = `${await ensureConfigDir(os)}/todo.json`;

  let backing: Backing = "local";
  let path = localFile;
  let body: string | null = null;
  try {
    await os.fs.mkdir(CLOUD_DIR).catch((error: unknown) => {
      if (codeOf(error) !== "EEXIST") throw error;
    });
    body = await readText(os, CLOUD_FILE);
    // Nothing there yet: start the shared copy from what this browser has,
    // so a list kept before signing in isn't left behind.
    if (body === null) {
      const seed = await os.fs.readTextFile(localFile).catch(() => null);
      body = serialize(parseData(seed));
      await os.fs.writeTextFile(CLOUD_FILE, body);
    }
    backing = "cloud";
    path = CLOUD_FILE;
  } catch {
    // No server, or not ours: this browser keeps its own list.
    body = await os.fs.readTextFile(localFile).catch(() => null);
  }

  let data = parseData(body);
  let known = serialize(data);
  let queue: Promise<void> = Promise.resolve();
  /** Changes not yet on disk. While any are, `data` is the optimistic copy. */
  let pending = 0;

  const read = async (): Promise<Data> => parseData(await readText(os, path));

  return {
    get data() {
      return data;
    },
    backing,
    path,
    async reload(): Promise<boolean> {
      // Never under a write that is still on its way out: the copy read back
      // could be the one from before it.
      await queue.catch(() => {});
      const next = await read().catch(() => null);
      if (!next || pending) return false;
      const after = serialize(next);
      if (after === known) return false;
      data = next;
      known = after;
      return true;
    },
    update(change): Promise<void> {
      const before = data;
      // Shown at once: the UI is already animating the tick it asked for.
      const optimistic = structuredClone(data);
      change(optimistic);
      data = parseData(serialize(optimistic));

      pending++;
      const run = async (): Promise<void> => {
        try {
          const latest = await read();
          const was = serialize(latest);
          change(latest);
          const next = parseData(serialize(latest));
          const body = serialize(next);
          if (body !== was) await os.fs.writeTextFile(path, body);
          known = body;
          // A later change is still queued and already on screen; adopting
          // this copy now would flicker it away until that one lands.
          if (pending === 1) data = next;
        } catch (error) {
          // Leave nothing on screen that isn't on disk.
          data = await read().catch(() => before);
          known = serialize(data);
          throw error;
        } finally {
          pending--;
        }
      };
      const done = queue.then(run, run);
      queue = done.catch(() => {});
      return done;
    },
  };
}
