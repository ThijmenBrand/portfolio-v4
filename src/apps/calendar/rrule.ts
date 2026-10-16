// RRULE text -> a struct. Parsing only; expand.ts turns it into occurrences.
import { parseDateValue } from "./ics.ts";
import { addDays, zonedToUtc } from "./zone.ts";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface ByDay {
  /** 0 is Sunday, like Date.getDay(). */
  day: number;
  /** 0 = every such weekday; 1..5 = the nth; -1..-5 = the nth from the end. */
  nth: number;
}

export interface Rrule {
  freq: Freq;
  /** At least 1. */
  interval: number;
  count?: number;
  /** An instant. Inclusive: an occurrence landing exactly on it still counts. */
  until?: number;
  byDay: ByDay[];
  /** 1..12. Empty means "the month DTSTART falls in" (YEARLY only). */
  byMonth: number[];
  /** 1..31 and -1..-31. Empty means "DTSTART's day of the month". */
  byMonthDay: number[];
  /** 0..6, default Monday. Only changes anything for WEEKLY with INTERVAL > 1. */
  wkst: number;
  /** Parts we read but ignore, so the UI can say the rule is approximated. */
  unsupported: string[];
}

const WEEKDAY: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const HANDLED = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTH",
  "BYMONTHDAY",
  "WKST",
]);

const BYDAY = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;

function ints(raw: string | undefined, lo: number, hi: number): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const piece of raw.split(",")) {
    const value = Number(piece.trim());
    if (!Number.isInteger(value) || value === 0) continue;
    if (Math.abs(value) >= lo && Math.abs(value) <= hi) out.push(value);
  }
  return out;
}

/**
 * null when FREQ is missing or outside the supported set, which is the signal
 * to treat the event as a one-off rather than to drop it.
 *
 * `zone` is the event's own zone, needed because Outlook sometimes writes a
 * local UNTIL where the RFC demands UTC.
 */
export function parseRrule(value: string, zone: string | null): Rrule | null {
  const parts: Record<string, string> = {};
  for (const piece of value.split(";")) {
    const at = piece.indexOf("=");
    if (at > 0) parts[piece.slice(0, at).trim().toUpperCase()] = piece.slice(at + 1).trim();
  }

  const freq = parts.FREQ?.toUpperCase();
  if (!freq || !FREQS.has(freq)) return null;

  const interval = Math.max(1, Math.trunc(Number(parts.INTERVAL)) || 1);
  const count = Number.isInteger(Number(parts.COUNT)) && Number(parts.COUNT) > 0
    ? Number(parts.COUNT)
    : undefined;

  let until: number | undefined;
  const rawUntil = parts.UNTIL ? parseDateValue(parts.UNTIL) : null;
  if (rawUntil) {
    // A bare DATE means the END of that day. Taking it as midnight silently
    // drops the final occurrence of every all-day series.
    const n = rawUntil.dateOnly ? addDays(rawUntil.n, 1) - 1000 : rawUntil.n;
    until = zonedToUtc(n, rawUntil.utc ? "UTC" : zone);
  }

  const byDay: ByDay[] = [];
  for (const piece of parts.BYDAY?.split(",") ?? []) {
    const match = BYDAY.exec(piece.trim().toUpperCase());
    if (!match) continue;
    const nth = match[1] ? Number(match[1]) : 0;
    if (Math.abs(nth) > 53) continue;
    byDay.push({ day: WEEKDAY[match[2]!]!, nth });
  }

  return {
    freq: freq as Freq,
    interval,
    ...(count !== undefined && { count }),
    ...(until !== undefined && { until }),
    byDay,
    byMonth: ints(parts.BYMONTH, 1, 12).filter((m) => m > 0),
    byMonthDay: ints(parts.BYMONTHDAY, 1, 31),
    wkst: WEEKDAY[parts.WKST?.toUpperCase() ?? ""] ?? 1,
    unsupported: Object.keys(parts).filter((key) => !HANDLED.has(key)),
  };
}
