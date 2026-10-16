// Turning a recurring event into the occurrences that fall in a window.
//
// Everything here walks in WALL CLOCK (see zone.ts) and converts to an instant
// only when an occurrence is emitted. The candidates a period produces are
// generated in strictly ascending order, within a period and across periods,
// which is what lets the walk stop at the first candidate past the window.
// Supporting BYSETPOS or BYHOUR would break that guarantee — don't add them
// without replacing the loop.
import type { CalEvent } from "./parse.ts";
import type { Freq, Rrule } from "./rrule.ts";
import {
  addDays,
  addMonths,
  DAY_MS,
  daysInMonth,
  fields,
  naive,
  utcToZoned,
  zonedToUtc,
  type Fields,
  type Naive,
} from "./zone.ts";

export interface Instance {
  event: CalEvent;
  start: Date;
  /** For an all-day event this is the EXCLUSIVE end midnight. */
  end: Date;
  allDay: boolean;
  /** Stable across refetches: good as a DOM key and for detail lookup. */
  key: string;
}

export interface Series {
  master: CalEvent;
  /** Same UID, carrying a RECURRENCE-ID. */
  overrides: CalEvent[];
}

/** Hard ceiling per series, so a pathological rule can't hang a render. */
export const MAX_OCCURRENCES = 2000;
/** Hard ceiling on period steps, for a rule whose candidates never land. */
export const MAX_PERIODS = 20_000;

function periodStart(n: Naive, freq: Freq, wkst: number): Naive {
  const f = fields(n);
  if (freq === "DAILY") return n;
  if (freq === "WEEKLY") return addDays(n, -(((f.wd - wkst) % 7) + 7) % 7);
  if (freq === "MONTHLY") return naive(f.y, f.mo, 1, f.h, f.mi, f.s);
  return naive(f.y, 1, 1, f.h, f.mi, f.s);
}

function addPeriods(cursor: Naive, count: number, freq: Freq): Naive {
  if (freq === "DAILY") return addDays(cursor, count);
  if (freq === "WEEKLY") return addDays(cursor, count * 7);
  // The cursor sits on the 1st (MONTHLY) or Jan 1st (YEARLY), so addMonths
  // never has to skip a missing day and never returns null here.
  return addMonths(cursor, freq === "MONTHLY" ? count : count * 12)!;
}

function periodsBetween(from: Naive, to: Naive, freq: Freq): number {
  if (freq === "DAILY") return Math.round((to - from) / DAY_MS);
  if (freq === "WEEKLY") return Math.round((to - from) / (7 * DAY_MS));
  const a = fields(from);
  const b = fields(to);
  const months = (b.y - a.y) * 12 + (b.mo - a.mo);
  return freq === "MONTHLY" ? months : b.y - a.y;
}

/** Days of the month a BYDAY entry picks out, ascending. */
function byDayDays(y: number, mo: number, day: number, nth: number): number[] {
  const last = daysInMonth(y, mo);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const offset = (((day - first) % 7) + 7) % 7;
  const all: number[] = [];
  for (let d = 1 + offset; d <= last; d += 7) all.push(d);
  if (nth === 0) return all;
  const pick = nth > 0 ? all[nth - 1] : all[all.length + nth];
  return pick === undefined ? [] : [pick];
}

/** The candidates one month contributes, ascending, at DTSTART's time of day. */
function monthCandidates(y: number, mo: number, rule: Rrule, at: Fields): Naive[] {
  const days = new Set<number>();
  if (rule.byDay.length) {
    for (const { day, nth } of rule.byDay) {
      for (const d of byDayDays(y, mo, day, nth)) days.add(d);
    }
    // BYMONTHDAY alongside BYDAY is a filter, not a second source.
    if (rule.byMonthDay.length) {
      const allowed = new Set(
        rule.byMonthDay.map((d) => (d > 0 ? d : daysInMonth(y, mo) + d + 1)),
      );
      for (const d of [...days]) if (!allowed.has(d)) days.delete(d);
    }
  } else {
    const last = daysInMonth(y, mo);
    for (const raw of rule.byMonthDay.length ? rule.byMonthDay : [at.d]) {
      const d = raw > 0 ? raw : last + raw + 1;
      // A month without a 31st is skipped, not rolled over into the next one.
      if (d >= 1 && d <= last) days.add(d);
    }
  }
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => naive(y, mo, d, at.h, at.mi, at.s));
}

function candidatesIn(cursor: Naive, rule: Rrule, at: Fields): Naive[] {
  const f = fields(cursor);
  if (rule.freq === "DAILY") {
    // An ordinal is meaningless with DAILY; BYDAY just filters the weekday.
    if (rule.byDay.length && !rule.byDay.some((b) => b.day === f.wd)) return [];
    return [cursor];
  }
  if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [at.wd];
    const offsets = [...new Set(days)].map((d) => (((d - rule.wkst) % 7) + 7) % 7);
    return offsets.sort((a, b) => a - b).map((o) => addDays(cursor, o));
  }
  if (rule.freq === "MONTHLY") return monthCandidates(f.y, f.mo, rule, at);
  const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [at.mo];
  return months.flatMap((mo) => monthCandidates(f.y, mo, rule, at));
}

const byStart = (a: Instance, b: Instance): number =>
  a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key);

/**
 * The event's own occurrences in [from, to), with EXDATE applied. Overrides
 * are NOT substituted here — expandSeries does that.
 */
export function expand(event: CalEvent, from: Date, to: Date): Instance[] {
  const out: Instance[] = [];
  const zone = event.zone;
  const excluded = new Set(event.exdate);
  const emitted = new Set<number>();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const allDayDays = event.allDay ? Math.round(event.durationMs / DAY_MS) : 0;

  const emit = (n: Naive): void => {
    const start = zonedToUtc(n, zone);
    if (excluded.has(start) || emitted.has(start)) return;
    const endNaive = event.allDay ? addDays(n, allDayDays) : n + event.durationMs;
    const end = zonedToUtc(endNaive, zone);
    // Intersection, not containment: a multi-day event that began before the
    // window still has to render inside it. The max() keeps a zero-length
    // event (a DATE-TIME start with no end) visible on its own instant.
    if (Math.max(end, start + 1) <= fromMs || start >= toMs) return;
    emitted.add(start);
    out.push({
      event,
      start: new Date(start),
      end: new Date(end),
      allDay: event.allDay,
      key: `${event.uid}@${start}`,
    });
  };

  // RDATEs are explicit and few, so they are always honoured, and an RDATE
  // that an EXDATE also names is still excluded.
  for (const n of event.rdate) emit(n);

  const rule = event.rrule;
  if (!rule) {
    emit(event.start);
    return out.sort(byStart);
  }

  const at = fields(event.start);
  const startMs = zonedToUtc(event.start, zone);
  let cursor = periodStart(event.start, rule.freq, rule.wkst);

  // Fast-forward only when COUNT is absent, because then the running count is
  // never read and skipping periods cannot lose track of it. When COUNT IS
  // set, the series has at most COUNT occurrences in its whole life, so
  // walking from DTSTART is already bounded by the rule itself. Either way the
  // hard "skip ahead while keeping an accurate count" code is never needed.
  if (rule.count === undefined && fromMs > startMs) {
    const target = periodStart(utcToZoned(fromMs, zone), rule.freq, rule.wkst);
    const gap = periodsBetween(cursor, target, rule.freq);
    if (gap > 0) {
      cursor = addPeriods(cursor, Math.floor(gap / rule.interval) * rule.interval, rule.freq);
    }
  }

  let seen = 0;
  for (let period = 0; period < MAX_PERIODS; period++) {
    for (const candidate of candidatesIn(cursor, rule, at)) {
      if (candidate < event.start) continue; // the lead-in of the first period
      seen++;
      if (rule.count !== undefined && seen > rule.count) return out.sort(byStart);
      const instant = zonedToUtc(candidate, zone);
      if (rule.until !== undefined && instant > rule.until) return out.sort(byStart);
      if (instant >= toMs) return out.sort(byStart);
      emit(candidate);
    }
    if (out.length >= MAX_OCCURRENCES) break;
    cursor = addPeriods(cursor, rule.interval, rule.freq);
  }
  return out.sort(byStart);
}

/** expand() plus override substitution. This is what query.ts calls. */
export function expandSeries(series: Series, from: Date, to: Date): Instance[] {
  // Every override, not only the ones inside the window: an instance that was
  // moved out of view must still be suppressed where it used to be.
  const replaced = new Set<number>();
  for (const override of series.overrides) {
    if (override.recurrenceId !== null) replaced.add(override.recurrenceId);
  }

  const out = expand(series.master, from, to).filter(
    (instance) => !replaced.has(instance.start.getTime()),
  );
  for (const override of series.overrides) {
    if (override.status === "CANCELLED") continue; // a single deleted instance
    // An override is a one-shot at its new time, which may be inside the
    // window even when the instance it replaces is not.
    out.push(...expand({ ...override, rrule: null, rdate: [] }, from, to));
  }
  return out.sort(byStart);
}

/** One Series per UID, with the overrides attached to their master. */
export function groupByUid(events: readonly CalEvent[]): Series[] {
  const masters = new Map<string, CalEvent>();
  const overrides = new Map<string, CalEvent[]>();

  for (const event of events) {
    if (event.recurrenceId === null) {
      const previous = masters.get(event.uid);
      // Highest SEQUENCE wins when a feed carries an old and a new copy.
      if (!previous || event.sequence >= previous.sequence) masters.set(event.uid, event);
    } else {
      const list = overrides.get(event.uid);
      if (list) list.push(event);
      else overrides.set(event.uid, [event]);
    }
  }

  const out: Series[] = [];
  for (const [uid, master] of masters) {
    out.push({ master, overrides: overrides.get(uid) ?? [] });
  }
  // An override with no master: Google's incremental feeds emit these, and
  // dropping them loses a real event.
  for (const [uid, list] of overrides) {
    if (masters.has(uid)) continue;
    for (const orphan of list) {
      out.push({ master: { ...orphan, recurrenceId: null }, overrides: [] });
    }
  }
  return out;
}
