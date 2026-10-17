// Events -> iCalendar text, for the calendars the app keeps itself (mine.ts).
//
// The inverse of parse.ts for everything parse.ts reads: a calendar written
// here and read back is the same calendar, which is what lets the store do a
// read-modify-write of a file without losing anything it didn't touch. What
// parse.ts drops (VALARM, ATTENDEE, BYSETPOS...) is not written, and the app
// never makes any of it.
//
// ponytail: times carry an IANA TZID with no VTIMEZONE block. RFC 5545 wants
// one, but every client worth importing into resolves IANA names directly,
// and a VTIMEZONE means shipping transition rules for every zone.
import type { CalEvent } from "./parse.ts";
import type { Rrule } from "./rrule.ts";
import { addDays, DAY_MS, fields, utcToZoned, type Naive } from "./zone.ts";

const PRODID = "-//Thijmen Brand//Portfolio OS Calendar//EN";
/** The calendar's colour and whether it is shown: ours, so X- names. */
export const HUE_PROP = "X-CALENDAR-HUE";
export const HIDDEN_PROP = "X-CALENDAR-HIDDEN";

export interface CalendarMeta {
  name: string;
  hue?: number;
  hidden?: boolean;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The inverse of unescapeText: backslash, semicolon, comma and newlines. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const octets = (char: string): number => {
  const code = char.codePointAt(0)!;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/**
 * RFC 5545 §3.1: no line longer than 75 octets. Folded between characters,
 * never inside one, so a multi-byte sequence survives (see unfold in ics.ts
 * for what happens to exporters that don't bother).
 */
export function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = octets(char);
    // A continuation line spends one octet on its leading space.
    if (size + width > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  out.push(current);
  return out.join("\r\n ");
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function dateText(n: Naive): string {
  const f = fields(n);
  return `${pad(f.y, 4)}${pad(f.mo)}${pad(f.d)}`;
}

function dateTimeText(n: Naive): string {
  const f = fields(n);
  return `${dateText(n)}T${pad(f.h)}${pad(f.mi)}${pad(f.s)}`;
}

/** An instant, in the UTC form every reader agrees on. */
const utcText = (ms: number): string => `${dateTimeText(utcToZoned(ms, "UTC"))}Z`;

/** DTSTART, DTEND and RDATE: a wall clock in the event's own zone. */
function wallLine(name: string, n: Naive, event: CalEvent): string {
  if (event.allDay) return `${name};VALUE=DATE:${dateText(n)}`;
  if (event.zone === "UTC") return `${name}:${dateTimeText(n)}Z`;
  if (event.zone === null) return `${name}:${dateTimeText(n)}`;
  return `${name};TZID=${event.zone}:${dateTimeText(n)}`;
}

/**
 * EXDATE and RECURRENCE-ID: parse.ts holds these as instants. An all-day
 * event's instants are local midnights (it has no zone), so they go back out
 * as plain dates; a timed one's go out in UTC, which names the same instant
 * whatever the event's zone.
 */
function instantLine(name: string, instants: readonly number[], event: CalEvent): string {
  return event.allDay
    ? `${name};VALUE=DATE:${instants.map((at) => dateText(utcToZoned(at, null))).join(",")}`
    : `${name}:${instants.map(utcText).join(",")}`;
}

export function formatRrule(rule: Rrule, allDay: boolean): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) {
    // An all-day UNTIL is the end of a local day (see parseRrule); its date is
    // what goes back out, as a DATE to match a DATE DTSTART.
    parts.push(`UNTIL=${allDay ? dateText(utcToZoned(rule.until, null)) : utcText(rule.until)}`);
  }
  if (rule.byDay.length) {
    parts.push(`BYDAY=${rule.byDay.map((b) => `${b.nth || ""}${WEEKDAYS[b.day]}`).join(",")}`);
  }
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.wkst !== 1) parts.push(`WKST=${WEEKDAYS[rule.wkst]}`);
  return parts.join(";");
}

function eventLines(event: CalEvent): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${escapeText(event.uid)}`, `DTSTAMP:${utcText(event.stamp)}`];
  if (event.recurrenceId !== null) {
    lines.push(instantLine("RECURRENCE-ID", [event.recurrenceId], event));
  }
  lines.push(wallLine("DTSTART", event.start, event));
  const end = event.allDay
    ? addDays(event.start, Math.max(1, Math.round(event.durationMs / DAY_MS)))
    : event.start + event.durationMs;
  lines.push(wallLine("DTEND", end, event));
  if (event.rrule) lines.push(`RRULE:${formatRrule(event.rrule, event.allDay)}`);
  if (event.exdate.length) lines.push(instantLine("EXDATE", event.exdate, event));
  for (const n of event.rdate) lines.push(wallLine("RDATE", n, event));

  const text = (name: string, value: string): void => {
    if (value) lines.push(`${name}:${escapeText(value)}`);
  };
  text("SUMMARY", event.summary);
  text("LOCATION", event.location);
  text("DESCRIPTION", event.description);
  // Not escaped: a URI value is not TEXT, and parse.ts reads it back raw.
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.categories.length) {
    lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
  }
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.transparent) lines.push("TRANSP:TRANSPARENT");
  if (event.sequence > 0) lines.push(`SEQUENCE:${event.sequence}`);
  lines.push("END:VEVENT");
  return lines;
}

/** A whole VCALENDAR, CRLF line endings and all, ready to write to disk. */
export function writeIcs(meta: CalendarMeta, events: readonly CalEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(meta.name)}`,
  ];
  if (meta.hue !== undefined) lines.push(`${HUE_PROP}:${meta.hue}`);
  if (meta.hidden) lines.push(`${HIDDEN_PROP}:TRUE`);
  for (const event of events) lines.push(...eventLines(event));
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
