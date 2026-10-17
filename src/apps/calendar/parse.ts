// Content lines -> a Calendar. Tolerant by construction: unknown components
// and properties fall through, and nothing in here ever throws. These bodies
// come off the internet, and half a calendar beats an exception.
import {
  parseDateValue,
  parseLine,
  splitList,
  unescapeText,
  unfold,
  type ContentLine,
} from "./ics.ts";
import { parseRrule, type Rrule } from "./rrule.ts";
import {
  DAY_MS,
  resolveZone,
  utcToZoned,
  zonedToUtc,
  type Naive,
} from "./zone.ts";

export interface CalEvent {
  uid: string;
  /** "" when absent; the UI shows "(no title)" rather than nothing. */
  summary: string;
  description: string;
  location: string;
  url: string;
  categories: string[];
  /** CANCELLED events are kept here and dropped in query.ts. */
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | "";
  /** TRANSP:TRANSPARENT — free, not busy. The UI dims these. */
  transparent: boolean;
  sequence: number;
  /** DTSTAMP (else LAST-MODIFIED) as an instant, 0 when absent. */
  stamp: number;

  allDay: boolean;
  /** DTSTART as a wall clock. Never an instant: see zone.ts. */
  start: Naive;
  /**
   * Nominal length in wall-clock ms: DTEND - DTSTART, else DURATION, else one
   * day (all-day) or zero (timed). Applied in wall clock, so a 10:00-11:00
   * meeting stays an hour across a DST boundary instead of becoming 0 or 2.
   */
  durationMs: number;
  /** Resolved IANA zone, "UTC", or null for floating and for all-day. */
  zone: string | null;

  rrule: Rrule | null;
  /** Instants, each resolved through its own TZID. Compared numerically. */
  exdate: number[];
  /** Wall clocks, normalised into the event's own zone. */
  rdate: Naive[];
  /** On an override only: the instant of the occurrence it replaces. */
  recurrenceId: number | null;
}

export interface Calendar {
  /** X-WR-CALNAME, else "". */
  name: string;
  /** REFRESH-INTERVAL, else X-PUBLISHED-TTL, in minutes. */
  ttlMinutes: number | null;
  events: CalEvent[];
  /** Anything we could not read. Never thrown; the app can surface these. */
  warnings: string[];
}

const DURATION =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** "PT1H30M" -> 5400000. null when it isn't a duration. */
export function parseDuration(value: string): number | null {
  const match = DURATION.exec(value.trim().toUpperCase());
  if (!match) return null;
  const [, sign, w, d, h, mi, s] = match;
  if (!w && !d && !h && !mi && !s) return null; // a bare "P" is not a duration
  const ms =
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * DAY_MS +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

interface Draft {
  props: Map<string, ContentLine>;
  exdate: ContentLine[];
  rdate: ContentLine[];
}

const STATUSES = new Set(["CONFIRMED", "TENTATIVE", "CANCELLED"]);

/** A DATE-TIME's own zone, which may differ from the event it sits in. */
function zoneOf(line: ContentLine, fallback: string | null): string | null {
  const value = parseDateValue(line.value);
  if (value?.utc) return "UTC";
  if (value?.dateOnly) return fallback;
  return line.params.TZID ? resolveZone(line.params.TZID) : fallback;
}

/**
 * Every EXDATE and RECURRENCE-ID becomes a UTC instant here, resolved through
 * its OWN TZID. Feeds disagree about how to write them — Google uses the
 * event's TZID and wall clock, Outlook writes UTC, Apple writes a bare DATE —
 * and normalising at parse time collapses all three onto the same number, so
 * expansion is a numeric Set lookup rather than a fuzzy match.
 */
function instantsOf(lines: ContentLine[], fallback: string | null): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const zone = zoneOf(line, fallback);
    for (const piece of splitList(line.value)) {
      // RDATE may carry a PERIOD ("start/end"); only the start interests us.
      const value = parseDateValue(piece.split("/")[0]!);
      if (value) out.push(zonedToUtc(value.n, value.utc ? "UTC" : zone));
    }
  }
  return out;
}

function finish(draft: Draft, index: number, warnings: string[]): CalEvent | null {
  const { props } = draft;
  const dtstart = props.get("DTSTART");
  const startValue = dtstart && parseDateValue(dtstart.value);
  if (!dtstart || !startValue) return null; // no start, no event

  const allDay =
    startValue.dateOnly || dtstart.params.VALUE?.toUpperCase() === "DATE";
  let zone: string | null = null;
  if (!allDay) {
    if (startValue.utc) zone = "UTC";
    else if (dtstart.params.TZID) {
      zone = resolveZone(dtstart.params.TZID);
      if (zone === null) {
        warnings.push(`unknown time zone "${dtstart.params.TZID}"`);
      }
    }
  }

  const start = startValue.n;
  let durationMs: number;
  const dtend = props.get("DTEND");
  const endValue = dtend && parseDateValue(dtend.value);
  const rawDuration = props.get("DURATION");
  if (endValue) {
    // All-day DTEND is EXCLUSIVE: 20261212..20261215 is a three-day event.
    durationMs = Math.max(0, endValue.n - start);
  } else if (rawDuration) {
    durationMs = Math.max(0, parseDuration(rawDuration.value) ?? 0);
  } else {
    // RFC 5545: a DATE-TIME start with no end is an instant. The views floor
    // the rendered height; the engine keeps it honest.
    durationMs = allDay ? DAY_MS : 0;
  }

  const text = (name: string): string => {
    const line = props.get(name);
    return line ? unescapeText(line.value).trim() : "";
  };

  const recurrence = props.get("RECURRENCE-ID");
  const rruleLine = props.get("RRULE");
  const status = text("STATUS").toUpperCase();
  const uid = text("UID");
  const stamp = props.get("DTSTAMP") ?? props.get("LAST-MODIFIED");

  return {
    uid: uid || `no-uid-${index}`,
    summary: text("SUMMARY"),
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    url: /^https:\/\//i.test(text("URL")) ? text("URL") : "",
    categories: (props.get("CATEGORIES")
      ? splitList(props.get("CATEGORIES")!.value)
      : []
    )
      .map((piece) => unescapeText(piece).trim())
      .filter(Boolean),
    status: STATUSES.has(status) ? (status as CalEvent["status"]) : "",
    transparent: text("TRANSP").toUpperCase() === "TRANSPARENT",
    sequence: Math.trunc(Number(text("SEQUENCE"))) || 0,
    stamp: stamp ? (instantsOf([stamp], "UTC")[0] ?? 0) : 0,

    allDay,
    start,
    durationMs,
    zone,

    rrule: rruleLine ? parseRrule(rruleLine.value, zone) : null,
    exdate: instantsOf(draft.exdate, zone),
    // Normalised into the event's own zone, so expansion has one currency.
    rdate: instantsOf(draft.rdate, zone).map((at) => utcToZoned(at, zone)),
    recurrenceId: recurrence ? (instantsOf([recurrence], zone)[0] ?? null) : null,
  };
}

/** Never throws. Garbage in, an empty-ish Calendar plus warnings out. */
export function parseIcs(text: string): Calendar {
  const warnings: string[] = [];
  const events: CalEvent[] = [];
  let name = "";
  let ttlMinutes: number | null = null;

  // A stack rather than a tree. Properties only apply when the innermost open
  // component is the one we care about, which is what keeps a VALARM's own
  // SUMMARY and DESCRIPTION from leaking into the event around it.
  const stack: string[] = [];
  let draft: Draft | null = null;
  let malformed = 0;

  for (const raw of unfold(text)) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (!line) {
      malformed++;
      continue;
    }

    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT") {
        draft = { props: new Map(), exdate: [], rdate: [] };
      }
      continue;
    }
    if (line.name === "END") {
      const closed = stack.pop();
      if (closed === "VEVENT" && draft) {
        const event = finish(draft, events.length, warnings);
        if (event) events.push(event);
        else warnings.push("skipped an event with no usable start");
        draft = null;
      }
      continue;
    }

    const inside = stack[stack.length - 1];
    if (inside === "VEVENT" && draft) {
      if (line.name === "EXDATE") draft.exdate.push(line);
      else if (line.name === "RDATE") draft.rdate.push(line);
      else draft.props.set(line.name, line);
    } else if (stack.length === 1 && inside === "VCALENDAR") {
      if (line.name === "X-WR-CALNAME") name = unescapeText(line.value).trim();
      else if (line.name === "REFRESH-INTERVAL" || line.name === "X-PUBLISHED-TTL") {
        const ms = parseDuration(line.value);
        // REFRESH-INTERVAL wins: X-PUBLISHED-TTL is the older, vaguer one.
        if (ms !== null && ms > 0 && (ttlMinutes === null || line.name === "REFRESH-INTERVAL")) {
          ttlMinutes = Math.round(ms / 60_000);
        }
      }
    }
  }

  if (malformed) warnings.push(`${malformed} line(s) could not be read`);
  return { name, ttlMinutes, events, warnings };
}
