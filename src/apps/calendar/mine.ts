// The calendars you make yourself, as opposed to the ones you subscribe to:
//
//   /mnt/cloud/calendar/mine/<id>.ics   where the cloud mount will have us
//   ~/.config/calendar/mine/<id>.ics    everywhere else
//
// One folder, never both. Which one is decided once, on open, by trying the
// mount -- the same test store.ts and the Todo app make, so all three always
// agree, and like them it never asks who is running the app. A folder that
// is new on the server is seeded from this browser's, so calendars made
// before signing in aren't left behind.
//
// The folder IS the list. Each file is a complete VCALENDAR carrying its own
// name, colour and visibility (see write.ts), so a calendar can be opened in
// Files, copied, or imported anywhere as it is, and there is no index file to
// drift out of step with the calendars it lists.
//
// Two browsers can edit one calendar, so every change is a read-modify-write
// of the latest file rather than a save of whatever this process last saw --
// otherwise adding an event here would quietly drop one added over there.
//
// Nothing here trusts a file: someone may have edited it by hand, and the id
// in its name becomes part of a path.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir } from "../../utils/settings";
import { parseLine, unfold } from "./ics.ts";
import { parseIcs, type CalEvent } from "./parse.ts";
import { MAX_ICS_BYTES, newId, type Backing } from "./store.ts";
import { HIDDEN_PROP, HUE_PROP, writeIcs } from "./write.ts";

export const CLOUD_DIR = "/mnt/cloud/calendar/mine";

export const MAX_CALENDARS = 12;
export const MAX_NAME = 60;
export const DEFAULT_NAME = "Calendar";

/** Only names like these are calendars; anything else in the folder is left alone. */
export const FILE = /^([a-z0-9]{1,16})\.ics$/i;

export interface OwnCalendar {
  /** Also the file's name. */
  id: string;
  name: string;
  /** 0..359. Unset: derived from the id, like a subscription's. */
  hue?: number;
  hidden: boolean;
  events: CalEvent[];
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "ERROR";
const failure = (code: string): Error => Object.assign(new Error(code), { code });

/** The file -> a calendar. Never throws: half a calendar beats none. */
export function readCalendar(id: string, text: string): OwnCalendar {
  const parsed = parseIcs(text);
  let hue: number | undefined;
  let hidden = false;
  // Our two properties sit in the calendar's header, before the first event.
  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VEVENT") break;
    if (line.name === HUE_PROP) {
      const value = Number(line.value);
      if (Number.isInteger(value) && value >= 0 && value < 360) hue = value;
    } else if (line.name === HIDDEN_PROP) {
      hidden = line.value.trim().toUpperCase() === "TRUE";
    }
  }
  return {
    id,
    name: parsed.name.slice(0, MAX_NAME) || DEFAULT_NAME,
    ...(hue !== undefined && { hue }),
    hidden,
    events: parsed.events,
  };
}

export const serializeCalendar = (calendar: OwnCalendar): string =>
  writeIcs(
    { name: calendar.name, hue: calendar.hue, hidden: calendar.hidden },
    calendar.events,
  );

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const sorted = (calendars: OwnCalendar[]): OwnCalendar[] =>
  calendars.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));

/** The sentence a failed save shows. Only the cloud's own wording names it. */
export function mineProblem(error: unknown, backing: Backing): string {
  switch (codeOf(error)) {
    case "EFBIG":
      return "That calendar is full. Delete some old events first.";
    case "ENOENT":
      return "That calendar was deleted somewhere else.";
    case "ENOSPC":
      return backing === "cloud" ? "There's no room left in cloud storage." : "There's no room left.";
    case "EACCES":
      if (backing === "cloud") return "Signed out — couldn't save.";
  }
  return "Couldn't save. Try again.";
}

/** True when the folder was made just now, false when it was already there. */
async function mkdir(os: AppInterface, path: string): Promise<boolean> {
  return os.fs.mkdir(path).then(
    () => true,
    (error: unknown) => {
      if (codeOf(error) !== "EEXIST") throw error;
      return false;
    },
  );
}

/** The calendar files in a folder, by id. */
async function list(os: AppInterface, dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const entry of await os.fs.readdir(dir)) {
    const match = entry.kind === "file" ? FILE.exec(entry.name) : null;
    if (match) out.set(match[1]!, entry.modifiedAt);
  }
  return out;
}

export interface MineStore {
  readonly backing: Backing;
  /** The folder: fs.changed for a path inside it means someone wrote it. */
  readonly dir: string;
  /** Sorted by name. Replaced on every change, never mutated in place. */
  readonly calendars: readonly OwnCalendar[];
  /** A fresh id no calendar here has. */
  newId(): string;
  /** Re-read the folder. True when anything differs from what we had. */
  reload(): Promise<boolean>;
  /** Write a calendar whole: a new one, or one brought back by Undo. */
  put(calendar: OwnCalendar): Promise<void>;
  /**
   * Apply `change` to the latest copy of a calendar on disk and write it
   * back. Shown at once; a failed write rejects and everything is re-read.
   *
   * `change` runs twice -- once on what is on screen, once on what is on
   * disk -- so it must be deterministic: make ids and timestamps outside it.
   */
  update(id: string, change: (calendar: OwnCalendar) => void): Promise<void>;
  remove(id: string): Promise<void>;
}

export async function openMine(os: AppInterface): Promise<MineStore> {
  const config = await ensureConfigDir(os);
  const localDir = `${config}/calendar/mine`;

  let backing: Backing = "local";
  let dir = localDir;
  try {
    await mkdir(os, "/mnt/cloud/calendar");
    // Seeded only when the folder is new: an empty one that already existed
    // is one whose calendars were all deleted, and must not come back.
    if (await mkdir(os, CLOUD_DIR)) {
      const here = await list(os, localDir).catch(() => new Map<string, number>());
      for (const id of here.keys()) {
        const body = await os.fs.readTextFile(`${localDir}/${id}.ics`);
        await os.fs.writeTextFile(`${CLOUD_DIR}/${id}.ics`, body);
      }
    }
    backing = "cloud";
    dir = CLOUD_DIR;
  } catch {
    // No server, or not ours: this browser keeps its own calendars.
    await mkdir(os, `${config}/calendar`);
    await mkdir(os, localDir);
  }

  const pathOf = (id: string): string => `${dir}/${id}.ics`;

  /** What each file held when we last read or wrote it. -1: written, not yet seen. */
  const known = new Map<string, { at: number; text: string }>();
  let calendars: OwnCalendar[] = [];
  let queue: Promise<void> = Promise.resolve();
  /** Changes not yet on disk. While any are, `calendars` is the optimistic copy. */
  let pending = 0;

  /** Everything on disk now, or null when the folder can't be read. */
  const scan = async (): Promise<OwnCalendar[] | null> => {
    const stamps = await list(os, dir).catch(() => null);
    if (!stamps) return null;
    const out: OwnCalendar[] = [];
    for (const [id, at] of stamps) {
      const was = known.get(id);
      const current = was && calendars.find((calendar) => calendar.id === id);
      if (was && current && was.at === at) {
        out.push(current);
        continue;
      }
      const text = await os.fs.readTextFile(pathOf(id)).catch(() => null);
      if (text === null) {
        if (current) out.push(current);
        continue;
      }
      // Our own write coming back round: nothing new, just learn its stamp.
      out.push(current && was?.text === text ? current : readCalendar(id, text));
      known.set(id, { at, text });
    }
    for (const id of known.keys()) if (!stamps.has(id)) known.delete(id);
    return sorted(out);
  };

  calendars = (await scan()) ?? [];

  const same = (a: readonly OwnCalendar[], b: readonly OwnCalendar[]): boolean =>
    a.length === b.length && a.every((calendar, index) => calendar === b[index]);

  const write = async (calendar: OwnCalendar): Promise<string> => {
    const body = serializeCalendar(calendar);
    if (body.length > MAX_ICS_BYTES) throw failure("EFBIG");
    await os.fs.writeTextFile(pathOf(calendar.id), body);
    known.set(calendar.id, { at: -1, text: body });
    return body;
  };

  /**
   * Show `next` at once and queue `run` behind every earlier change. On
   * failure, leave nothing on screen that isn't on disk.
   */
  const enqueue = (next: OwnCalendar[], run: () => Promise<void>): Promise<void> => {
    calendars = sorted(next);
    pending++;
    const step = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        known.clear();
        calendars = (await scan()) ?? calendars;
        throw error;
      } finally {
        pending--;
      }
    };
    const done = queue.then(step, step);
    queue = done.catch(() => {});
    return done;
  };

  const without = (id: string): OwnCalendar[] =>
    calendars.filter((calendar) => calendar.id !== id);

  return {
    backing,
    dir,
    get calendars() {
      return calendars;
    },
    newId(): string {
      let id = newId();
      while (known.has(id) || calendars.some((calendar) => calendar.id === id)) id = newId();
      return id;
    },
    async reload(): Promise<boolean> {
      // Never under a write still on its way out: the copy read back could be
      // the one from before it.
      await queue;
      const next = await scan();
      if (!next || pending) return false;
      if (same(next, calendars)) return false;
      calendars = next;
      return true;
    },
    put(calendar): Promise<void> {
      const copy = structuredClone(calendar);
      return enqueue([...without(copy.id), copy], async () => {
        await write(copy);
      });
    },
    update(id, change): Promise<void> {
      const current = calendars.find((calendar) => calendar.id === id);
      if (!current) return Promise.reject(failure("ENOENT"));
      const optimistic = structuredClone(current);
      change(optimistic);
      return enqueue([...without(id), optimistic], async () => {
        const text = await os.fs.readTextFile(pathOf(id));
        const latest = readCalendar(id, text);
        change(latest);
        const body = serializeCalendar(latest);
        if (body !== text) await write(latest);
        // A later change is still queued and already on screen; adopting
        // this copy now would flicker it away until that one lands.
        if (pending === 1) calendars = sorted([...without(id), readCalendar(id, body)]);
      });
    },
    remove(id): Promise<void> {
      return enqueue(without(id), async () => {
        await os.fs.unlink(pathOf(id)).catch((error: unknown) => {
          if (codeOf(error) !== "ENOENT") throw error;
        });
        known.delete(id);
      });
    },
  };
}
