// Fetching a subscription and turning it into events.
//
// Everything a user can see here is deliberately neutral about WHY a fetch
// failed. os.net.fetch is gated on the admin group, so for most people it
// throws EPERM — and EPERM has to be indistinguishable from the backend being
// down, or the error message would advertise that an owner account exists.
// EPERM and EIO therefore map to the same sentence, byte for byte.
import type { AppInterface } from "../../kernel/syscalls/api";
import { parseIcs } from "./parse.ts";
import {
  clampMinutes,
  MAX_CACHE_BYTES,
  MAX_ICS_BYTES,
  type Source,
  type Store,
} from "./store.ts";

/** The one message that must cover every reason a feed didn't arrive. */
export const UNREACHABLE = "Couldn't reach that calendar.";
/** Shown under a failed link row. The same for everyone, and always true. */
export const IMPORT_HINT = "You can import an .ics file instead.";

const BACKOFF_CAP_MINUTES = 360;
/** Two at a time: one backend endpoint, and the status line stays truthful. */
const POOL = 2;

/** An error whose message is already written for the user. */
class FeedError extends Error {}

function httpMessage(status: number): string {
  if (status === 404 || status === 410) return "That calendar isn't there any more.";
  if (status === 401 || status === 403) return "That calendar is private.";
  if (status === 429 || status >= 500) return "That calendar is busy. Trying again later.";
  return UNREACHABLE;
}

function messageFor(error: unknown): string {
  if (error instanceof FeedError) return error.message;
  switch ((error as { code?: string }).code) {
    // EPERM is a visitor hitting the admin-only syscall; EIO is the backend
    // being unreachable, DNS failing, or the address being refused. One
    // sentence for both, on purpose.
    case "EPERM":
    case "EIO":
      return UNREACHABLE;
    case "EINVAL":
      return "That address isn't a calendar link.";
    case "ENOENT":
      return "That file isn't there any more.";
    case "EACCES":
      return "You can't read that file.";
    default:
      return UNREACHABLE;
  }
}

function decode(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/^﻿/, "");
  } catch {
    // Older feeds are still latin-1, and mojibake beats no calendar at all.
    return new TextDecoder("windows-1252").decode(body);
  }
}

/**
 * Lenient on purpose: plenty of hosts serve .ics as text/plain or as
 * application/octet-stream, so only reject when the type AND the body
 * disagree with us.
 */
function looksLikeCalendar(contentType: string, body: string): boolean {
  return (
    contentType.trim().toLowerCase().startsWith("text/calendar") ||
    body.slice(0, 2048).includes("BEGIN:VCALENDAR")
  );
}

interface Fetched {
  body: string;
  bytes: number;
}

async function fetchUrl(os: AppInterface, source: Source): Promise<Fetched> {
  const response = await os.net.fetch(source.url!);
  if (response.status !== 200) throw new FeedError(httpMessage(response.status));
  if (response.body.length > MAX_ICS_BYTES) {
    throw new FeedError("That calendar is too big.");
  }
  const body = decode(response.body);
  if (!looksLikeCalendar(response.contentType, body)) {
    throw new FeedError("That link isn't a calendar.");
  }
  return { body, bytes: response.body.length };
}

async function readImported(os: AppInterface, source: Source): Promise<Fetched> {
  const raw = await os.fs.readFile(source.path!);
  if (raw.length > MAX_ICS_BYTES) throw new FeedError("That calendar is too big.");
  const body = decode(raw);
  if (!looksLikeCalendar("", body)) throw new FeedError("That file isn't a calendar.");
  return { body, bytes: raw.length };
}

/** When this source may next be fetched. A dead feed backs off exponentially. */
export function dueAt(source: Source): number {
  const base = source.lastTry ?? 0;
  if (!source.failures) return base + source.refreshMinutes * 60_000;
  const penalty = Math.min(BACKOFF_CAP_MINUTES, 5 * 2 ** Math.min(source.failures, 7));
  return base + penalty * 60_000;
}

export interface SyncDeps {
  os: AppInterface;
  store: Store;
  /** `body` is the new text to parse, or null when the attempt failed. */
  onChange(source: Source, body: string | null): void;
}

/**
 * Never throws, and never discards what we already have: a failed refresh
 * leaves the cached body and the rendered events exactly where they were.
 */
export async function syncOne(deps: SyncDeps, source: Source): Promise<void> {
  source.lastTry = Date.now();
  try {
    const { body, bytes } =
      source.kind === "url"
        ? await fetchUrl(deps.os, source)
        : await readImported(deps.os, source);

    const others = deps.store.cachedBytes() - (source.bytes ?? 0);
    if (others + bytes > MAX_CACHE_BYTES) {
      throw new FeedError("There isn't room for another calendar. Remove one first.");
    }

    const parsed = parseIcs(body);
    await deps.store.writeCache(source.id, body);

    source.bytes = bytes;
    source.lastSync = Date.now();
    source.failures = 0;
    delete source.lastError;
    source.refreshMinutes = clampMinutes(parsed.ttlMinutes);
    if (parsed.name && !source.renamed) source.name = parsed.name.slice(0, 60);
    deps.onChange(source, body);
  } catch (error) {
    source.failures = (source.failures ?? 0) + 1;
    source.lastError = messageFor(error);
    deps.onChange(source, null);
  }
  deps.store.save();
}

/** A small pool, so twelve subscriptions don't open twelve requests at once. */
export async function syncMany(deps: SyncDeps, sources: readonly Source[]): Promise<void> {
  const queue = [...sources];
  await Promise.all(
    Array.from({ length: Math.min(POOL, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await syncOne(deps, next);
      }
    }),
  );
}

/** The enabled sources whose refresh interval (or backoff) has elapsed. */
export function due(sources: readonly Source[], now: number): Source[] {
  return sources.filter((source) => source.enabled && now >= dueAt(source));
}
