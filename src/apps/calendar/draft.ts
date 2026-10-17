// What the event editor hands over -> the event that gets written, and back.
//
// Times are entered as wall clocks on this device and saved in its zone, so
// a 10:00 meeting made in Amsterdam stays 10:00 Amsterdam time when it is
// looked at from London. Editing a repeating event changes the whole series:
// the editor shows the occurrence that was clicked, and whatever it was moved
// by is what the series' first occurrence moves by too -- which is what "all
// events" means in every other calendar.
import type { CalEvent } from "./parse.ts";
import type { Freq, Rrule } from "./rrule.ts";
import { DAY_MS, startOfDay, utcToZoned, zonedToUtc, type Naive } from "./zone.ts";

export const FREQS: readonly Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
export const MAX_INTERVAL = 99;
export const MAX_TITLE = 200;
export const MAX_TEXT = 4000;
/** One second short of midnight: how an UNTIL date is read (see parseRrule). */
const DAY_END = DAY_MS - 1000;

export interface Repeat {
  freq: Freq;
  interval: number;
  /** The last day it may happen on, as local midnight. Null: forever. */
  until: Naive | null;
}

export interface Draft {
  summary: string;
  location: string;
  description: string;
  /** Already checked to be https, or "". */
  url: string;
  allDay: boolean;
  /** Wall clocks on this device. All-day: midnights, with `end` exclusive. */
  start: Naive;
  end: Naive;
  repeat: Repeat | null;
}

/** This device's IANA zone, or null (floating) if the browser won't say. */
export function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** A Date as the wall clock this device shows for it. */
export const wallOf = (at: Date): Naive => utcToZoned(at.getTime(), null);

/** What someone typed as a link -> an https address, "" for none, null if refused. */
export function cleanUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+-]*:/i.test(text) ? text : `https://${text}`);
    // parse.ts only ever keeps https links, so anything else would vanish on
    // the way back in.
    return url.protocol === "https:" && url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

/** The editor's Repeat fields, read back off an event. */
export function repeatOf(event: CalEvent): Repeat | null {
  const rule = event.rrule;
  if (!rule) return null;
  return {
    freq: rule.freq,
    interval: rule.interval,
    until:
      rule.until === undefined
        ? null
        : startOfDay(utcToZoned(rule.until, event.allDay ? null : event.zone)),
  };
}

function ruleFor(repeat: Repeat, allDay: boolean, zone: string | null, base: Rrule | null): Rrule {
  // Whatever the editor can't show (BYDAY lists in a hand-written file, say)
  // survives an edit that leaves the frequency alone, and only that.
  const kept = base && base.freq === repeat.freq ? base : null;
  return {
    freq: repeat.freq,
    interval: Math.min(MAX_INTERVAL, Math.max(1, Math.round(repeat.interval))),
    ...(repeat.until !== null
      ? { until: zonedToUtc(repeat.until + DAY_END, allDay ? null : zone) }
      : kept?.count !== undefined && { count: kept.count }),
    byDay: kept?.byDay ?? [],
    byMonth: kept?.byMonth ?? [],
    byMonthDay: kept?.byMonthDay ?? [],
    wkst: kept?.wkst ?? 1,
    unsupported: [],
  };
}

export interface BuildOptions {
  uid: string;
  /** Now, made outside so the store's change function stays deterministic. */
  stamp: number;
  /** The zone timed events are saved in: deviceZone(). */
  zone: string | null;
  /** The event being edited, if it isn't a new one. */
  base?: CalEvent;
  /** When editing a series: the start of the occurrence that was opened. */
  occurrence?: Date;
}

export function buildEvent(draft: Draft, options: BuildOptions): CalEvent {
  const { base } = options;
  const zone = draft.allDay ? null : options.zone;
  const length = Math.max(0, draft.end - draft.start);

  let start = draft.start;
  let shifted = true;
  // A series that stops repeating becomes the one occurrence on screen, where
  // the editor showed it, rather than jumping back to the series' first date.
  if (base?.rrule && draft.repeat && options.occurrence) {
    // Move the series by as much as the occurrence on screen was moved.
    const delta = draft.start - wallOf(options.occurrence);
    start = wallOf(new Date(zonedToUtc(base.start, base.zone))) + delta;
    if (draft.allDay) start = startOfDay(start);
    shifted = delta !== 0;
  }

  // A series moved in time no longer lands on the instants its exceptions name.
  const keepExceptions = base !== undefined && !shifted && base.allDay === draft.allDay;

  return {
    uid: options.uid,
    summary: draft.summary.trim().slice(0, MAX_TITLE),
    description: draft.description.trim().slice(0, MAX_TEXT),
    location: draft.location.trim().slice(0, MAX_TEXT),
    url: draft.url,
    categories: base?.categories ?? [],
    status: base?.status === "CANCELLED" ? "" : (base?.status ?? ""),
    transparent: base?.transparent ?? false,
    sequence: base ? base.sequence + 1 : 0,
    stamp: options.stamp,
    allDay: draft.allDay,
    start,
    durationMs: draft.allDay ? Math.max(DAY_MS, Math.round(length / DAY_MS) * DAY_MS) : length,
    zone,
    rrule: draft.repeat ? ruleFor(draft.repeat, draft.allDay, zone, base?.rrule ?? null) : null,
    exdate: keepExceptions ? base.exdate : [],
    rdate: keepExceptions ? base.rdate : [],
    recurrenceId: base?.recurrenceId ?? null,
  };
}
