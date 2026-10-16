// Wall clocks, instants, and the one-way door between them.
//
// Recurrence has to be expanded in WALL CLOCK, never in UTC milliseconds.
// "Every Tuesday at 10:00 Europe/Amsterdam" is 08:00Z in October and 09:00Z in
// November; an engine that adds 7 * 86400000 to an instant drifts an hour at
// every DST boundary. So the engine's currency is a Naive, and the conversion
// to a real instant happens exactly once, per emitted occurrence.
//
// This is the only file in the app that touches Intl time zones.
import { WINDOWS_ZONES } from "./zones.ts";

/**
 * A wall clock with no zone attached, encoded through Date.UTC. The UTC part
 * is a carrier, not a meaning: never hand a Naive to anything that formats or
 * displays a date. What it buys us is exact 86 400 000 ms days, free weekday
 * and field access, and Date.UTC's overflow normalisation.
 */
export type Naive = number;

const MIN = 60_000;
const HALF_DAY = 12 * 3_600_000;

export const DAY_MS = 86_400_000;

/** Month is 1-based, to match how ICS writes it. */
export function naive(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Naive {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC maps years 0-99 onto 1900-1999; undo that for the rare old date.
  return y >= 0 && y < 100 ? new Date(ms).setUTCFullYear(y) : ms;
}

export interface Fields {
  y: number;
  /** 1-based. */
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0 is Sunday, like Date.getDay() and shortcuts' schedule.ts. */
  wd: number;
}

export function fields(n: Naive): Fields {
  const at = new Date(n);
  return {
    y: at.getUTCFullYear(),
    mo: at.getUTCMonth() + 1,
    d: at.getUTCDate(),
    h: at.getUTCHours(),
    mi: at.getUTCMinutes(),
    s: at.getUTCSeconds(),
    wd: at.getUTCDay(),
  };
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Exact, because a zone-free day is always 24 hours long. */
export function addDays(n: Naive, days: number): Naive {
  return n + days * DAY_MS;
}

/**
 * null when the target month has no such day. RFC 5545 says a MONTHLY rule on
 * the 31st SKIPS the months that have no 31st, whereas Date.UTC(2026, 1, 31)
 * silently rolls over to March 3rd.
 */
export function addMonths(n: Naive, months: number): Naive | null {
  const f = fields(n);
  const total = f.y * 12 + (f.mo - 1) + months;
  const y = Math.floor(total / 12);
  const mo = total - y * 12 + 1;
  if (f.d > daysInMonth(y, mo)) return null;
  return naive(y, mo, f.d, f.h, f.mi, f.s);
}

/** Midnight at the start of the Naive's day. */
export function startOfDay(n: Naive): Naive {
  return n - ((n % DAY_MS) + DAY_MS) % DAY_MS;
}

// ---------------------------------------------------------------- zones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    // hourCycle h23, not hour12:false: an h24 engine renders midnight as "24".
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, found);
  }
  return found;
}

/**
 * Minutes east of UTC in `zone` at instant `ms`.
 *
 * Rendering the instant as a wall clock and differencing the two, rather than
 * reading timeZoneName "longOffset": that needs a regex over a localized
 * string, and emits things like GMT-00:44:30 for pre-1972 zones.
 */
export function offsetAt(ms: number, zone: string): number {
  const part: Record<string, string> = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) {
    part[type] = value;
  }
  const wall = Date.UTC(
    Number(part.year),
    Number(part.month) - 1,
    Number(part.day),
    Number(part.hour),
    Number(part.minute),
    Number(part.second),
  );
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MIN);
}

// A render re-asks for the same handful of (zone, wall clock) pairs over and
// over, so this hits almost every time after the first paint.
// ponytail: dropped wholesale at the cap rather than evicted LRU-style. The
// key space is small and repetitive; a real LRU would cost more than it saves.
const CACHE_CAP = 20_000;
const instants = new Map<string, number>();

/**
 * The instant a wall clock names in `zone`. A null zone is floating: the
 * viewer's own zone, which is what RFC 5545 says a TZID-less DATE-TIME means.
 *
 * The two interesting cases are the ones a naive "look up the offset and
 * subtract" gets wrong. In a DST gap (02:30 on a spring-forward morning never
 * happens) we shift forward, so 02:30 renders as 03:30. In a DST overlap
 * (02:30 happens twice) we take the earlier one. Both match what every other
 * calendar client does, so our rendering agrees with theirs.
 */
export function zonedToUtc(n: Naive, zone: string | null): number {
  if (zone === null) {
    const f = fields(n);
    return new Date(f.y, f.mo - 1, f.d, f.h, f.mi, f.s).getTime();
  }
  if (zone === "UTC") return n;

  const key = `${zone}|${n}`;
  const hit = instants.get(key);
  if (hit !== undefined) return hit;

  // ponytail: the +/-12h probe assumes a zone doesn't change offset twice in
  // twelve hours, nor jump more than ~14 hours. True for every tzdb zone.
  const before = offsetAt(n - HALF_DAY, zone);
  const after = offsetAt(n + HALF_DAY, zone);
  const a = n - before * MIN;
  const b = n - after * MIN;
  const aOk = offsetAt(a, zone) === before;
  const bOk = offsetAt(b, zone) === after;
  // Only one of the two candidates round-trips, except in an overlap (both do,
  // take the earlier) and in a gap (neither does, so `a` shifts us forward).
  const out = aOk && bOk ? Math.min(a, b) : bOk && !aOk ? b : a;

  if (instants.size >= CACHE_CAP) instants.clear();
  instants.set(key, out);
  return out;
}

/** The other direction: what clock `zone` shows at that instant. */
export function utcToZoned(ms: number, zone: string | null): Naive {
  const whole = Math.floor(ms / 1000) * 1000;
  if (zone === null) {
    const at = new Date(ms);
    return naive(
      at.getFullYear(),
      at.getMonth() + 1,
      at.getDate(),
      at.getHours(),
      at.getMinutes(),
      at.getSeconds(),
    );
  }
  if (zone === "UTC") return whole;
  return whole + offsetAt(ms, zone) * MIN;
}

const known = new Map<string, boolean>();

function isZone(name: string): boolean {
  let verdict = known.get(name);
  if (verdict === undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: name });
      verdict = true;
    } catch {
      verdict = false;
    }
    known.set(name, verdict);
  }
  return verdict;
}

/**
 * A feed's TZID -> a zone Intl will accept, or null for floating.
 *
 * Handles real IANA names, the Windows names Exchange writes, the
 * "/mozilla.org/20050126_1/Europe/Amsterdam" prefixes some exporters bolt on,
 * and the UTC spellings. Anything left over is floating: visibly off by a few
 * hours at worst, and parse.ts records a warning.
 */
export function resolveZone(tzid: string | undefined): string | null {
  const name = tzid?.trim();
  if (!name) return null;
  if (/^(utc|gmt|z)$/i.test(name)) return "UTC";

  // "/mozilla.org/20050126_1/Europe/Amsterdam" -> "Europe/Amsterdam"
  const parts = name.replace(/^\/+/, "").split("/");
  const tail = parts.length > 2 ? parts.slice(-2).join("/") : name;

  for (const candidate of [name, tail]) {
    if (isZone(candidate)) return candidate;
    const mapped = WINDOWS_ZONES[candidate];
    if (mapped) return mapped;
  }

  const lower = name.toLowerCase();
  for (const [windows, iana] of Object.entries(WINDOWS_ZONES)) {
    if (windows.toLowerCase() === lower) return iana;
  }
  return null;
}
