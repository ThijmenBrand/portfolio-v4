// What the Calendar keeps on disk:
//
//   ~/.config/calendar.json      the subscriptions
//   ~/.config/calendar/<id>.ics  the last body fetched for each one
//
// The bodies are cached so the views draw instantly on launch and keep working
// with no network at all. Nothing here trusts the file: someone may have
// edited it by hand, and `id` becomes part of a path.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir } from "../../utils/settings";
import { hueOf } from "../../utils/hue";

export const VIEWS = ["month", "week", "agenda"] as const;
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

export interface Store {
  readonly data: Data;
  /** Fire and forget; failures reach the UI through the onError passed to open. */
  save(): void;
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
  await os.fs.mkdir(cacheDir).catch((error: unknown) => {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  });

  let raw: unknown = null;
  try {
    raw = JSON.parse(await os.fs.readTextFile(file));
  } catch {
    /* no file yet, or not JSON: start empty */
  }
  const given = (raw ?? {}) as Partial<Data>;

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

  const data: Data = {
    sources,
    view: VIEWS.includes(given.view as View) ? (given.view as View) : "month",
  };

  return {
    data,
    save(): void {
      os.fs
        .writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`)
        .catch((error: unknown) => {
          console.error("[calendar]", error);
          onError("Couldn't save. Try again.");
        });
    },
    readCache: (id) => os.fs.readTextFile(`${cacheDir}/${id}.ics`).catch(() => null),
    writeCache: async (id, body) => {
      await os.fs.writeTextFile(`${cacheDir}/${id}.ics`, body);
    },
    dropCache: async (id) => {
      await os.fs.unlink(`${cacheDir}/${id}.ics`).catch(() => {});
    },
    cachedBytes: () => data.sources.reduce((total, source) => total + (source.bytes ?? 0), 0),
  };
}
