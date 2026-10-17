// Which calendar events are a course's sessions, and what the free time
// between everything is. Pure: no DOM, no filesystem, so it is checked on its
// own (projects.check.ts).
//
// A uni timetable names a course inconsistently -- "SOS VO" in one export,
// "Software Systems (Lecture)" in another -- but the course's code or name is
// reliably somewhere in the title or the notes. So an event is a session when
// the code or the name appears in either, as a whole word: "SOS" finds
// "SOS VO" and "SOS UE" but not "SOSE VO", which is another course. The word
// after the code in the title is the session's type ("VO").
import { expandSeries, groupByUid } from "../calendar/expand.ts";
import type { CalEvent } from "../calendar/parse.ts";

export interface Session {
  start: Date;
  end: Date;
  title: string;
  /** "VO", "UE"…: the word after the code in the title, or "" when there is none. */
  type: string;
  location: string;
  /** Stable across re-reads. */
  key: string;
}

/** One regular slot: "Mondays 9:00–11:00 · HS 1". */
export interface Slot {
  type: string;
  /** Date.getDay(). */
  weekday: number;
  from: string;
  to: string;
  location: string;
  count: number;
}

export interface TypeSummary {
  type: string;
  count: number;
  first: Date;
  last: Date;
  /** Repeating slots, most frequent first. Empty for a one-off like an exam. */
  slots: Slot[];
}

const LETTER = /[\p{L}\p{N}]/u;

/** `needle` in `haystack` as a whole word (or words), ignoring case. */
export function hasWord(haystack: string, needle: string): boolean {
  const h = haystack.toLocaleLowerCase();
  const n = needle.trim().toLocaleLowerCase();
  if (!n) return false;
  for (let at = h.indexOf(n); at !== -1; at = h.indexOf(n, at + 1)) {
    const before = at > 0 ? h[at - 1]! : "";
    const after = h[at + n.length] ?? "";
    if (!LETTER.test(before) && !LETTER.test(after)) return true;
  }
  return false;
}

const words = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether `event` belongs to the course with this code and/or name. */
export function isSession(event: CalEvent, code: string, name: string): boolean {
  const places = [event.summary, event.description];
  return places.some((place) => (code && hasWord(place, code)) || (name && hasWord(place, name)));
}

/**
 * The session's type: the short word that follows the code in the title
 * ("SOS VO" -> "VO"). "" when the title doesn't carry the code, or what
 * follows isn't an abbreviation.
 */
export function typeOf(title: string, code: string): string {
  if (!code) return "";
  const list = words(title);
  const codeWords = words(code).map((word) => word.toLocaleLowerCase());
  for (let i = 0; i + codeWords.length <= list.length; i++) {
    const hit = codeWords.every((word, k) => list[i + k]!.toLocaleLowerCase() === word);
    if (!hit) continue;
    const next = list[i + codeWords.length] ?? "";
    return /^\p{L}{1,4}$/u.test(next) ? next.toLocaleUpperCase() : "";
  }
  return "";
}

/**
 * A title that starts like the code but is another word ("SOSE VO" for
 * "SOS"): shown as not included, so a near miss is visible rather than silent.
 */
export function nearMiss(event: CalEvent, code: string): string | null {
  const first = words(event.summary)[0] ?? "";
  const lower = first.toLocaleLowerCase();
  const want = code.trim().toLocaleLowerCase();
  if (!want || words(code).length !== 1) return null;
  return lower.startsWith(want) && lower !== want ? first.toLocaleUpperCase() : null;
}

/** Every session of the course in [from, to), sorted, `skip` types left out. */
export function sessionsOf(
  events: readonly CalEvent[],
  code: string,
  name: string,
  from: Date,
  to: Date,
  skip: readonly string[] = [],
): Session[] {
  if (!code.trim() && !name.trim()) return [];
  const matched = events.filter((event) => isSession(event, code.trim(), name.trim()));
  const out: Session[] = [];
  for (const series of groupByUid(matched)) {
    if (series.master.status === "CANCELLED") continue;
    for (const instance of expandSeries(series, from, to)) {
      if (instance.event.status === "CANCELLED") continue;
      const type = typeOf(instance.event.summary, code.trim());
      if (skip.includes(type)) continue;
      out.push({
        start: instance.start,
        end: instance.end,
        title: instance.event.summary,
        type,
        location: instance.event.location,
        key: instance.key,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key));
}

const pad = (n: number): string => String(n).padStart(2, "0");
export const hhmm = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** Sessions grouped by type, each with its regular weekly slots. */
export function summarize(sessions: readonly Session[]): TypeSummary[] {
  const byType = new Map<string, Session[]>();
  for (const session of sessions) {
    const list = byType.get(session.type) ?? [];
    list.push(session);
    byType.set(session.type, list);
  }
  const out: TypeSummary[] = [];
  for (const [type, list] of byType) {
    const slots = new Map<string, Slot>();
    for (const session of list) {
      if (session.end.getTime() - session.start.getTime() >= 86_400_000) continue;
      const slot = {
        type,
        weekday: session.start.getDay(),
        from: hhmm(session.start),
        to: hhmm(session.end),
        location: session.location.trim(),
        count: 0,
      };
      const key = `${slot.weekday}|${slot.from}|${slot.to}|${slot.location}`;
      const known = slots.get(key) ?? slot;
      known.count++;
      slots.set(key, known);
    }
    out.push({
      type,
      count: list.length,
      first: list[0]!.start,
      last: list.at(-1)!.end,
      slots: [...slots.values()]
        .filter((slot) => slot.count >= 2)
        .sort((a, b) => b.count - a.count || ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.from.localeCompare(b.from)),
    });
  }
  // Most sessions first: the lecture before the one-off exam.
  return out.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** The near misses among `events`, with how often each occurs (as events, not sessions). */
export function nearMisses(events: readonly CalEvent[], code: string, name: string): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (isSession(event, code.trim(), name.trim())) continue;
    const word = nearMiss(event, code);
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
}

/** A session counts as on from this long before it starts: time to walk there. */
export const LEAD_MS = 10 * 60_000;

export const sessionNow = (sessions: readonly Session[], now: Date): Session | undefined =>
  sessions.find((s) => s.start.getTime() - LEAD_MS <= now.getTime() && now < s.end);

export const nextSession = (sessions: readonly Session[], now: Date): Session | undefined =>
  sessions.find((s) => s.end > now);

// -------------------------------------------------------------- free time --

export interface Span {
  start: number;
  end: number;
}

/** Looked for between these hours, in minutes after midnight. */
export const DAY_FROM = 8 * 60;
export const DAY_TO = 20 * 60;
/** Shorter gaps aren't worth offering. */
export const MIN_FREE = 60;

/**
 * The gaps of at least MIN_FREE minutes in `day` between DAY_FROM and
 * DAY_TO that no busy span covers. On today the day starts at `now`,
 * rounded up to a quarter hour: time already gone is not free.
 */
export function freeSlots(day: Date, busy: readonly Span[], now: Date): Span[] {
  const at = (minutes: number): number =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime();
  let from = at(DAY_FROM);
  const to = at(DAY_TO);
  const quarter = 15 * 60_000;
  from = Math.max(from, Math.ceil(now.getTime() / quarter) * quarter);
  if (from >= to) return [];

  const spans = busy
    .map((span) => ({ start: Math.max(span.start, from), end: Math.min(span.end, to) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let cursor = from;
  for (const span of spans) {
    if (span.start - cursor >= MIN_FREE * 60_000) out.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (to - cursor >= MIN_FREE * 60_000) out.push({ start: cursor, end: to });
  return out;
}
