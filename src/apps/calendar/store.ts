// What the Calendar keeps on disk:
//
//   /mnt/cloud/calendar/subscriptions.json  the list itself, on the server
//   ~/.config/calendar.json                 this browser's copy of it, plus
//                                           what only this browser knows
//   ~/.config/calendar/<id>.ics             the last body fetched for each one
//
// The split is deliberate. Which calendars you subscribe to, what you called
// them and what colour they are is yours, so it lives on the server and every
// browser signed in as the owner sees the same list. When it last synced, how
// large the body was and whether the last attempt failed belongs to the
// browser that did the syncing, so it stays here -- otherwise two browsers
// would spend the day overwriting each other's bookkeeping.
//
// /mnt/cloud is the owner's mount and refuses everyone else, exactly as it
// refuses in Files. That is a storage answer, not an answer about who is
// running the app: a refusal simply leaves the list in this browser, which is
// where it lived before there was a server at all.
//
// The bodies are cached so the views draw instantly on launch and keep working
// with no network at all. Nothing here trusts the file: someone may have
// edited it by hand, and `id` becomes part of a path.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir } from "../../utils/settings";
import { hueOf } from "../../utils/hue";

/** The owner's copy, the same in every browser they sign in to. */
const CLOUD_DIR = "/mnt/cloud/calendar";
const CLOUD_FILE = `${CLOUD_DIR}/subscriptions.json`;
/** Quiet after an edit before the shared copy is written. */
const CLOUD_SAVE_MS = 600;

export const VIEWS = ["month", "week", "day", "agenda"] as const;
export type View = (typeof VIEWS)[number];

export interface Source {
  /** Also the cache file's name, so it is validated hard on load. */
  id: string;
  kind: "url" | "file";
  /** kind "url": an https address. */
  url?: string;
  /** kind "file": the VFS path it was imported from, re-read on refresh. */
  path?: string;
  /** The user's label, seeded from the feed's own X-WR-CALNAME. */
  name: string;
  /** The user named it themselves, so a sync must not overwrite that. */
  renamed?: boolean;
  /** 0..359, overriding the colour derived from the address. */
  hue?: number;
  enabled: boolean;
  /** Resolved from the feed's refresh interval, clamped. */
  refreshMinutes: number;
  /** Last success, and last attempt of any kind: the backoff reads the latter. */
  lastSync?: number;
  lastTry?: number;
  failures?: number;
  /** The neutral sentence shown on the row, stored verbatim. */
  lastError?: string;
  bytes?: number;
}

export interface Data {
  sources: Source[];
  view: View;
  /** Draw the Todo app's dated todos alongside the calendars. */
  todos: boolean;
  /** Draw those todos' deadlines too. Only matters while `todos` is on. */
  deadlines: boolean;
  /** The calendar of your own the last event was saved to, offered first next time. */
  lastCalendar?: string;
}

export const MAX_SOURCES = 12;
/** Per calendar. The backend refuses anything over 5 MiB anyway. */
export const MAX_ICS_BYTES = 2 * 1024 * 1024;
/** Everything together. The real limit is parse time, not disk. */
export const MAX_CACHE_BYTES = 12 * 1024 * 1024;

export const FLOOR_MINUTES = 15;
export const CEILING_MINUTES = 1440;
const DEFAULT_MINUTES = 60;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * What someone pastes -> an address we can fetch, or null.
 *
 * webcal: is the important one: most "Subscribe" buttons in the wild hand out
 * a webcal:// link, and without the rewrite the app looks broken.
 */
export function toIcsUrl(input: string): URL | null {
  const text = input.trim();
  if (!text) return null;
  try {
    // No dots in a scheme, so "example.com:8080/x.ics" still gets a scheme.
    const url = new URL(/^[a-z][a-z\d+-]*:/i.test(text) ? text : `https://${text}`);
    if (url.protocol === "webcal:" || url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" && url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

/** A starting point for the name, until a sync reads the feed's own. */
export function guessFeedName(from: URL | string): string {
  const text = typeof from === "string" ? from : from.pathname;
  const file = text.split("/").filter(Boolean).at(-1) ?? "";
  const stem = file.replace(/\.ics$/i, "").replace(/[-_+]/g, " ").trim();
  // Google's feeds end in "basic.ics" behind an opaque id, which tells nobody
  // anything; fall back to the host in that case.
  if (stem && stem.length <= 40 && !/^(basic|calendar|ical|index)$/i.test(stem)) {
    return stem[0]!.toUpperCase() + stem.slice(1);
  }
  if (typeof from === "string") return "Calendar";
  const host = from.hostname.replace(/^www\./, "");
  return host[0]!.toUpperCase() + host.slice(1);
}

/** The colour a subscription draws with, unless the user picked one. */
export function hueFor(source: Source): number {
  return source.hue ?? hueOf(source.url ?? source.path ?? source.id);
}

export function clampMinutes(minutes: number | null | undefined): number {
  if (!Number.isFinite(minutes ?? NaN)) return DEFAULT_MINUTES;
  return Math.min(CEILING_MINUTES, Math.max(FLOOR_MINUTES, Math.round(minutes!)));
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const num = (value: unknown, lo: number, hi: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, Math.round(value)))
    : fallback;

function cleanSource(raw: unknown): Source | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Source>;
  const kind = given.kind === "file" ? "file" : "url";
  const url = kind === "url" ? toIcsUrl(text(given.url)) : null;
  const path = kind === "file" ? text(given.path) : "";
  // Keep only what we could still read; a half-written source is noise.
  if (kind === "url" ? !url : !path.startsWith("/")) return null;

  // The id is interpolated into a cache path, so a hand-edited "../../etc/x"
  // must not survive. Anything that isn't plainly alphanumeric is replaced.
  const id = /^[a-z0-9]{1,16}$/i.test(text(given.id)) ? text(given.id) : newId();
  const name = text(given.name).slice(0, 60);

  return {
    id,
    kind,
    ...(url && { url: url.href }),
    ...(path && { path }),
    name: name || (url ? guessFeedName(url) : guessFeedName(path)),
    ...(given.renamed === true && { renamed: true as const }),
    ...(given.hue !== undefined && { hue: num(given.hue, 0, 359, 0) }),
    enabled: given.enabled !== false,
    refreshMinutes: clampMinutes(
      typeof given.refreshMinutes === "number" ? given.refreshMinutes : null,
    ),
    ...(typeof given.lastSync === "number" && { lastSync: given.lastSync }),
    ...(typeof given.lastTry === "number" && { lastTry: given.lastTry }),
    failures: num(given.failures, 0, 99, 0),
    ...(text(given.lastError) && { lastError: text(given.lastError).slice(0, 200) }),
    ...(typeof given.bytes === "number" && { bytes: num(given.bytes, 0, MAX_ICS_BYTES, 0) }),
  };
}

/** Where the subscriptions are kept: on the server, or only in this browser. */
export type Backing = "cloud" | "local";

/** The half of a subscription that is the person's, not this browser's. */
type SharedSource = Pick<
  Source,
  "id" | "kind" | "url" | "path" | "name" | "renamed" | "hue" | "enabled"
>;

function shared(source: Source): SharedSource {
  return {
    id: source.id,
    kind: source.kind,
    ...(source.url && { url: source.url }),
    ...(source.path && { path: source.path }),
    name: source.name,
    ...(source.renamed && { renamed: true as const }),
    ...(source.hue !== undefined && { hue: source.hue }),
    enabled: source.enabled,
  };
}

/** Exactly what the shared copy should contain, so a no-op write is skipped. */
const sharedText = (sources: readonly Source[]): string =>
  `${JSON.stringify({ sources: sources.map(shared) }, null, 2)}\n`;

/**
 * The shared list decides which calendars exist and how they look; this
 * browser keeps what it alone knows. A source whose address changed somewhere
 * else loses that bookkeeping, which is what makes it sync again at once.
 */
function merge(incoming: Source[], here: readonly Source[]): Source[] {
  const mine = new Map(here.map((source) => [source.id, source]));
  return incoming.map((source) => {
    const known = mine.get(source.id);
    if (!known) return source;
    if (known.url !== source.url || known.path !== source.path) {
      return { ...source, refreshMinutes: known.refreshMinutes, failures: 0 };
    }
    return {
      ...source,
      refreshMinutes: known.refreshMinutes,
      ...(known.lastSync !== undefined && { lastSync: known.lastSync }),
      ...(known.lastTry !== undefined && { lastTry: known.lastTry }),
      failures: known.failures ?? 0,
      ...(known.lastError && { lastError: known.lastError }),
      ...(known.bytes !== undefined && { bytes: known.bytes }),
    };
  });
}

function parseJson(body: string | null): Partial<Data> {
  try {
    const raw: unknown = JSON.parse(body ?? "");
    return raw && typeof raw === "object" ? (raw as Partial<Data>) : {};
  } catch {
    return {}; // no file yet, or not JSON: start empty
  }
}

function readSources(given: Partial<Data>): Source[] {
  const sources: Source[] = [];
  for (const entry of Array.isArray(given.sources) ? given.sources : []) {
    const source = cleanSource(entry);
    if (source) sources.push(source);
    if (sources.length >= MAX_SOURCES) break;
  }
  // Two sources must never share an id: it is the cache file's name.
  const seen = new Set<string>();
  for (const source of sources) {
    while (seen.has(source.id)) source.id = newId();
    seen.add(source.id);
  }
  return sources;
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "ERROR";

async function mkdir(os: AppInterface, path: string): Promise<void> {
  await os.fs.mkdir(path).catch((error: unknown) => {
    if (codeOf(error) !== "EEXIST") throw error;
  });
}

/** Null for "not there"; anything else is a real failure and is thrown. */
async function readText(os: AppInterface, path: string): Promise<string | null> {
  try {
    return await os.fs.readTextFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** When the server last changed the file, or 0 if it won't say. */
const stampOf = (os: AppInterface, path: string): Promise<number> =>
  os.fs.stat(path).then((entry) => entry.modifiedAt, () => 0);

/**
 * Only ever shown to someone the server has already let in, so these may name
 * cloud storage; nothing here is reachable by a visitor.
 */
function cloudProblem(error: unknown): string {
  switch (codeOf(error)) {
    case "ENOSPC":
      return "There's no room left in cloud storage.";
    case "EACCES":
      return "Signed out — this change stays in this browser.";
    default:
      return "Couldn't reach cloud storage. This change stays in this browser.";
  }
}

export interface Store {
  readonly data: Data;
  /** Where the subscriptions live. "cloud" follows the person, "local" the browser. */
  readonly backing: Backing;
  /** Fire and forget; failures reach the UI through the onError passed to open. */
  save(): void;
  /**
   * Re-read the shared copy. True when another browser had changed it, in
   * which case `data.sources` is now that list.
   */
  pull(): Promise<boolean>;
  readCache(id: string): Promise<string | null>;
  writeCache(id: string, body: string): Promise<void>;
  dropCache(id: string): Promise<void>;
  /** Everything cached right now, for the total-size cap. */
  cachedBytes(): number;
}

export async function openStore(
  os: AppInterface,
  onError: (message: string) => void,
): Promise<Store> {
  const config = await ensureConfigDir(os);
  const file = `${config}/calendar.json`;
  const cacheDir = `${config}/calendar`;
  await mkdir(os, cacheDir);

  const local = parseJson(await os.fs.readTextFile(file).catch(() => null));
  const data: Data = {
    sources: readSources(local),
    view: VIEWS.includes(local.view as View) ? (local.view as View) : "month",
    todos: local.todos !== false,
    deadlines: local.deadlines !== false,
    ...(typeof local.lastCalendar === "string" && { lastCalendar: local.lastCalendar }),
  };

  // What the server holds, and when we last agreed with it. Reaching it at
  // all is the whole test: if the mount turns us away the list stays here.
  let backing: Backing = "local";
  let seenAt = 0;
  let pushed = "";
  try {
    await mkdir(os, CLOUD_DIR);
    const body = await readText(os, CLOUD_FILE);
    // Nothing there yet: start the shared copy from what this browser has,
    // so a list built before signing in isn't left behind.
    if (body === null) await os.fs.writeTextFile(CLOUD_FILE, sharedText(data.sources));
    else data.sources = merge(readSources(parseJson(body)), data.sources);
    pushed = sharedText(data.sources);
    seenAt = await stampOf(os, CLOUD_FILE);
    backing = "cloud";
  } catch {
    /* no server, or not ours: this browser keeps its own list */
  }

  const dropCache = async (id: string): Promise<void> => {
    await os.fs.unlink(`${cacheDir}/${id}.ics`).catch(() => {});
  };

  // The local copy is written every time: it is what the app reads on launch
  // with no network, and what the upnext menu bar extra reads.
  const saveLocal = (): void => {
    os.fs.writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`).catch((error: unknown) => {
      console.error("[calendar]", error);
      onError("Couldn't save. Try again.");
    });
  };

  let pending: ReturnType<typeof setTimeout> | undefined;

  const push = async (): Promise<void> => {
    pending = undefined;
    const body = sharedText(data.sources);
    // A sync writes the bookkeeping on every tick; none of that is shared, so
    // most saves have nothing new to send.
    if (body === pushed) return;
    try {
      await os.fs.writeTextFile(CLOUD_FILE, body);
      pushed = body;
      seenAt = await stampOf(os, CLOUD_FILE);
    } catch (error) {
      console.error("[calendar]", error);
      onError(cloudProblem(error));
    }
  };

  return {
    data,
    backing,
    save(): void {
      saveLocal();
      if (backing !== "cloud") return;
      clearTimeout(pending);
      pending = setTimeout(() => void push(), CLOUD_SAVE_MS);
    },
    async pull(): Promise<boolean> {
      // Never while this browser's own edit is still on its way out.
      if (backing !== "cloud" || pending !== undefined) return false;
      const at = await stampOf(os, CLOUD_FILE);
      if (!at || at === seenAt) return false;
      const body = await readText(os, CLOUD_FILE).catch(() => null);
      // An edit made while the read was in flight is this browser's own and
      // newer than what came back: leave the stamp alone so the next tick
      // looks again, once that edit has gone out.
      if (body === null || pending !== undefined) return false;

      seenAt = at;
      const next = merge(readSources(parseJson(body)), data.sources);
      const after = sharedText(next);
      // The same list written again by another browser: nothing to adopt.
      if (after === sharedText(data.sources)) return false;

      const gone = new Set(data.sources.map((source) => source.id));
      for (const source of next) gone.delete(source.id);
      data.sources = next;
      pushed = after;
      saveLocal();
      for (const id of gone) await dropCache(id);
      return true;
    },
    readCache: (id) => os.fs.readTextFile(`${cacheDir}/${id}.ics`).catch(() => null),
    writeCache: async (id, body) => {
      await os.fs.writeTextFile(`${cacheDir}/${id}.ics`, body);
    },
    dropCache,
    cachedBytes: () => data.sources.reduce((total, source) => total + (source.bytes ?? 0), 0),
  };
}
