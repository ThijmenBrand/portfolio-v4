// The calendars, read-only: what the Calendar app has cached for each
// subscription, and the calendars of your own it keeps. The same reading
// upnext does (src/bin/upnext). Nothing here fetches -- the Calendar owns
// syncing -- and nothing here writes.
//
// Bodies are parsed once and kept until the file's modification time moves,
// so re-reading on every minute tick costs a stat per calendar.
import type { AppInterface } from "../../kernel/syscalls/api";
import { CLOUD_DIR as MINE_CLOUD, FILE, readCalendar } from "../calendar/mine.ts";
import { parseIcs, type CalEvent } from "../calendar/parse.ts";
import { hueOf } from "../../utils/hue";

export interface Cal {
  /** A subscription's id, or "mine:<id>" for one of your own. */
  id: string;
  name: string;
  hue: number;
  events: readonly CalEvent[];
}

interface Stored {
  sources?: { id?: unknown; name?: unknown; enabled?: unknown; hue?: unknown; url?: unknown; path?: unknown }[];
}

interface Cached {
  /** Modification time and size: what says the file was written again. */
  at: string;
  events: readonly CalEvent[];
  name: string;
  hue?: number;
  hidden?: boolean;
}

export interface CalendarReader {
  /** The visible calendars, as last read. Replaced on change. */
  readonly calendars: readonly Cal[];
  /** Bumped whenever `calendars` changes. */
  readonly revision: number;
  /** Re-read what changed. True when anything did. */
  refresh(): Promise<boolean>;
  /** Whether an fs.changed path is one of ours. */
  watches(path: string): boolean;
}

export async function openCalendars(os: AppInterface): Promise<CalendarReader> {
  const home = (await os.process.env()).HOME ?? "/";
  const configFile = `${home}/.config/calendar.json`;
  const cacheDir = `${home}/.config/calendar`;
  const localMine = `${cacheDir}/mine`;

  const cache = new Map<string, Cached>();
  let calendars: readonly Cal[] = [];
  let revision = 0;
  let seen = "";

  const stamp = async (path: string): Promise<string | null> =>
    os.fs.stat(path).then(
      (stat) => `${stat.modifiedAt}:${stat.size}`,
      () => null,
    );

  /** A file parsed, or the copy from last time when it hasn't moved. */
  async function load(path: string, parse: (body: string) => Omit<Cached, "at">): Promise<Cached | null> {
    const at = await stamp(path);
    if (at === null) {
      cache.delete(path);
      return null;
    }
    const known = cache.get(path);
    if (known && known.at === at) return known;
    const body = await os.fs.readTextFile(path).catch(() => null);
    if (body === null) return null;
    const next = { at, ...parse(body) };
    cache.set(path, next);
    return next;
  }

  async function mine(): Promise<Cal[]> {
    let dir = MINE_CLOUD;
    let names = await os.fs.readdir(dir).catch(() => null);
    if (!names) {
      dir = localMine;
      names = await os.fs.readdir(dir).catch(() => []);
    }
    const out: Cal[] = [];
    for (const entry of names) {
      const match = entry.kind === "file" ? FILE.exec(entry.name) : null;
      if (!match) continue;
      const id = match[1]!;
      const read = await load(`${dir}/${entry.name}`, (body) => {
        const calendar = readCalendar(id, body);
        return { events: calendar.events, name: calendar.name, hue: calendar.hue, hidden: calendar.hidden };
      });
      if (read && !read.hidden) {
        out.push({ id: `mine:${id}`, name: read.name, hue: read.hue ?? hueOf(id), events: read.events });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function subscribed(): Promise<Cal[]> {
    let config: Stored;
    try {
      config = JSON.parse(await os.fs.readTextFile(configFile)) as Stored;
    } catch {
      return [];
    }
    const out: Cal[] = [];
    for (const source of Array.isArray(config.sources) ? config.sources : []) {
      const id = typeof source?.id === "string" && /^[a-z0-9]{1,16}$/i.test(source.id) ? source.id : "";
      if (!id || source.enabled === false) continue;
      const read = await load(`${cacheDir}/${id}.ics`, (body) => ({ events: parseIcs(body).events, name: "" }));
      if (!read) continue;
      const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : "Calendar";
      const hue =
        typeof source.hue === "number"
          ? source.hue
          : hueOf(String(source.url ?? source.path ?? id));
      out.push({ id, name, hue, events: read.events });
    }
    return out;
  }

  async function refresh(): Promise<boolean> {
    const next = [...(await mine()), ...(await subscribed())];
    const key = next.map((cal) => `${cal.id}:${cal.name}:${cal.hue}:${cal.events.length}`).join("|")
      + `|${[...cache.values()].map((c) => c.at).join(",")}`;
    if (key === seen) return false;
    seen = key;
    calendars = next;
    revision++;
    return true;
  }

  await refresh();

  return {
    get calendars() {
      return calendars;
    },
    get revision() {
      return revision;
    },
    refresh,
    watches: (path) =>
      path === configFile || path.startsWith(`${cacheDir}/`) || path.startsWith(`${MINE_CLOUD}/`),
  };
}
