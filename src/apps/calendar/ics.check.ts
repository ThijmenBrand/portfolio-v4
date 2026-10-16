// Self-check for the ICS engine: `node src/apps/calendar/ics.check.ts` (or `pnpm check`).
//
// Instants are asserted as ISO strings for events that name a real zone, and
// against locally-built Dates for floating and all-day ones, so the file
// passes whatever TZ the runner happens to be in.
import { expand, expandSeries, groupByUid } from "./expand.ts";
import { parseDateValue, parseLine, splitList, unescapeText, unfold } from "./ics.ts";
import { parseDuration, parseIcs } from "./parse.ts";
import { occurrencesIn } from "./query.ts";
import { parseRrule } from "./rrule.ts";
import { addMonths, daysInMonth, naive, resolveZone, zonedToUtc } from "./zone.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const wrap = (body: string) => `BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR\r\n`;
const one = (body: string) => parseIcs(wrap(`BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`)).events[0]!;
const iso = (list: { start: Date }[]) => list.map((i) => i.start.toISOString());
const at = (text: string) => new Date(text);
/** A local midnight, for windowing against all-day events, which are floating. */
const day = (y: number, mo: number, d: number) => new Date(y, mo - 1, d);

// ------------------------------------------------------------------ lexer

eq(unfold("A:1\r\n bc\r\nD:2"), ["A:1bc", "D:2"], "a space continues the line before");
eq(unfold("A:1\r\n\tbc"), ["A:1bc"], "a tab continues it too");
eq(unfold("A:1\r\n  two"), ["A:1 two"], "exactly one fold character is stripped");
eq(unfold("A:1\nB:2"), ["A:1", "B:2"], "bare newlines survive a text-mode proxy");
eq(unfold(" x"), [" x"], "a leading continuation with nothing to join stays put");

eq(parseLine("SUMMARY:Lunch: 12:00")?.value, "Lunch: 12:00", "only the first colon ends the name");
eq(parseLine(String.raw`ATTENDEE;CN="Doe, John";ROLE=REQ:mailto:j@x.com`)?.params,
  { CN: "Doe, John", ROLE: "REQ" }, "a comma inside a quoted parameter does not split it");
eq(parseLine(String.raw`X;CN="a:b":v`)?.value, "v", "a colon inside quotes does not end the parameters");
eq(parseLine(String.raw`X;CN="a;b":v`)?.params.CN, "a;b", "nor does a semicolon");
eq(parseLine("DTSTART;VALUE=DATE:20261212")?.params.VALUE, "DATE", "a plain parameter");
eq(parseLine("dtstart;tzid=Europe/Amsterdam:1")?.name, "DTSTART", "names are upper-cased");
eq(parseLine("dtstart;tzid=Europe/Amsterdam:1")?.params.TZID, "Europe/Amsterdam",
  "parameter keys are upper-cased, their values keep their case");
eq(parseLine("garbage with no colon"), null, "a line with no colon is not a content line");
eq(parseLine(""), null, "nor is a blank one");
eq(parseLine("X:")?.value, "", "an empty value is still a content line");

eq(unescapeText(String.raw`a\, b\; c\nd\\e`), "a, b; c\nd\\e", "TEXT escapes");
eq(unescapeText(String.raw`a\Nb`), "a\nb", "\\N is a newline too");
eq(unescapeText(String.raw`a\qb`), "aqb", "an unknown escape keeps its character");
eq(splitList(String.raw`a,b\,c,d`).map(unescapeText), ["a", "b,c", "d"],
  "a list splits on unescaped commas only");

eq(parseDateValue("20261212")?.dateOnly, true, "a bare DATE");
eq(parseDateValue("20261006T100000Z")?.utc, true, "a UTC DATE-TIME");
eq(parseDateValue("20261006T100000")?.utc, false, "a local DATE-TIME");
eq(parseDateValue("nonsense"), null, "anything else is not a date");

// ------------------------------------------------------------------ zones

const zoned = (y: number, mo: number, d: number, h: number, mi: number, zone: string) =>
  new Date(zonedToUtc(naive(y, mo, d, h, mi), zone)).toISOString();

eq(zoned(2026, 3, 29, 1, 59, "Europe/Amsterdam"), "2026-03-29T00:59:00.000Z", "the last CET minute");
eq(zoned(2026, 3, 29, 2, 30, "Europe/Amsterdam"), "2026-03-29T01:30:00.000Z",
  "a time in the spring-forward gap shifts forward");
eq(zoned(2026, 10, 25, 2, 30, "Europe/Amsterdam"), "2026-10-25T00:30:00.000Z",
  "an ambiguous autumn time takes the earlier instant");
eq(zoned(2026, 3, 8, 2, 30, "America/New_York"), "2026-03-08T07:30:00.000Z", "the US gap");
eq(zoned(2026, 11, 1, 1, 30, "America/New_York"), "2026-11-01T05:30:00.000Z", "the US overlap");
eq(zoned(2026, 4, 5, 1, 45, "Australia/Lord_Howe"), "2026-04-04T14:45:00.000Z", "a 30-minute DST shift");
eq(zoned(2026, 6, 1, 12, 0, "Asia/Kolkata"), "2026-06-01T06:30:00.000Z", "a half-hour zone");
eq(zoned(2026, 6, 1, 12, 0, "Pacific/Chatham"), "2026-05-31T23:15:00.000Z", "a 45-minute zone");
eq(zoned(2026, 6, 1, 12, 0, "UTC"), "2026-06-01T12:00:00.000Z", "UTC needs no lookup");

eq(addMonths(naive(2026, 1, 31), 1), null, "a MONTHLY step skips a month with no 31st");
eq(new Date(addMonths(naive(2026, 1, 31), 2)!).toISOString(), "2026-03-31T00:00:00.000Z",
  "and lands normally on the next month that has one");
eq([daysInMonth(2024, 2), daysInMonth(2026, 2), daysInMonth(1900, 2)], [29, 28, 28], "leap years");

eq(resolveZone("Europe/Amsterdam"), "Europe/Amsterdam", "an IANA name passes through");
eq(resolveZone("W. Europe Standard Time"), "Europe/Berlin", "a Windows name is mapped");
eq(resolveZone("/mozilla.org/20050126_1/Europe/Amsterdam"), "Europe/Amsterdam", "a prefixed name is trimmed");
eq(resolveZone("UTC"), "UTC", "UTC");
eq(resolveZone("Z"), "UTC", "Z means UTC");
eq(resolveZone(undefined), null, "no TZID is floating");
eq(resolveZone("Mars/Olympus"), null, "an unknown zone is floating");

// ------------------------------------------------------------------ rrule

eq(parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR", null)?.byDay,
  [{ day: 1, nth: 0 }, { day: 3, nth: 0 }, { day: 5, nth: 0 }], "plain BYDAY");
eq(parseRrule("FREQ=MONTHLY;BYDAY=2TU,-1FR", null)?.byDay,
  [{ day: 2, nth: 2 }, { day: 5, nth: -1 }], "ordinal BYDAY, forwards and backwards");
eq(parseRrule("FREQ=DAILY", null)?.interval, 1, "INTERVAL defaults to 1");
eq(parseRrule("FREQ=DAILY", null)?.wkst, 1, "WKST defaults to Monday");
eq(parseRrule("FREQ=MINUTELY", null), null, "a FREQ outside the subset is not a rule");
eq(parseRrule("FREQ=DAILY;BYSETPOS=-1", null)?.unsupported, ["BYSETPOS"],
  "an unsupported part is recorded, and the rest of the rule still parses");
eq(new Date(parseRrule("FREQ=DAILY;UNTIL=20261231T235959Z", null)!.until!).toISOString(),
  "2026-12-31T23:59:59.000Z", "a UTC UNTIL");
eq(parseRrule("FREQ=DAILY;UNTIL=20261231", "UTC")!.until, Date.UTC(2026, 11, 31, 23, 59, 59),
  "a bare-DATE UNTIL means the END of that day");

// ------------------------------------------------- expansion: the core case

// 2026-10-06 is a Tuesday, and the Amsterdam DST change falls between the
// 20 October and 3 November occurrences.
const standup = one(
  "UID:standup@google.com\r\n" +
  "DTSTART;TZID=Europe/Amsterdam:20261006T100000\r\n" +
  "DTEND;TZID=Europe/Amsterdam:20261006T110000\r\n" +
  "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=TU\r\n" +
  "EXDATE;TZID=Europe/Amsterdam:20261027T100000\r\n" +
  "SUMMARY:Standup\r\n" +
  String.raw`DESCRIPTION:Weekly sync\, room may move\; check.\nSecond line.`,
);
const autumn = expand(standup, at("2026-10-01"), at("2026-12-01"));

eq(autumn.length, 7, "eight Tuesdays less the excluded one");
eq(iso(autumn), [
  "2026-10-06T08:00:00.000Z",
  "2026-10-13T08:00:00.000Z",
  "2026-10-20T08:00:00.000Z",
  "2026-11-03T09:00:00.000Z",
  "2026-11-10T09:00:00.000Z",
  "2026-11-17T09:00:00.000Z",
  "2026-11-24T09:00:00.000Z",
], "the wall clock stays 10:00 while the instant moves an hour across the DST change");
eq(autumn.every((i) => i.end.getTime() - i.start.getTime() === 3_600_000), true,
  "and the nominal hour survives the boundary");
eq(iso(expand(standup, at("2026-11-02"), at("2026-11-09"))), ["2026-11-03T09:00:00.000Z"],
  "a one-week window returns the same instant it would in a wider one");
eq(standup.description, "Weekly sync, room may move; check.\nSecond line.", "the escaped description");

// ------------------------------------------------- expansion: counting rules

const daily = (rule: string, uid = "c") =>
  one(`UID:${uid}\r\nDTSTART:20260101T090000Z\r\nRRULE:${rule}`);

eq(expand(daily("FREQ=DAILY;COUNT=10"), at("2026-06-01"), at("2026-07-01")).length, 0,
  "a COUNT exhausted in January yields nothing in June");
eq(iso(expand(daily("FREQ=DAILY;COUNT=400"), at("2027-02-01"), at("2027-02-10"))), [
  "2027-02-01T09:00:00.000Z",
  "2027-02-02T09:00:00.000Z",
  "2027-02-03T09:00:00.000Z",
  "2027-02-04T09:00:00.000Z",
], "COUNT is counted from DTSTART, so the series runs out mid-window");
eq(iso(expand(daily("FREQ=DAILY;UNTIL=20260103T090000Z"), at("2026-01-01"), at("2026-02-01"))), [
  "2026-01-01T09:00:00.000Z",
  "2026-01-02T09:00:00.000Z",
  "2026-01-03T09:00:00.000Z",
], "UNTIL includes an occurrence landing exactly on it");

// ---------------------------------------------- expansion: calendar geometry

const monthly = (start: string, rule: string) =>
  one(`UID:m\r\nDTSTART:${start}\r\nRRULE:${rule}`);

eq(iso(expand(monthly("20260130T090000Z", "FREQ=MONTHLY;BYDAY=-1FR"), at("2026-01-01"), at("2026-05-01"))),
  ["2026-01-30T09:00:00.000Z", "2026-02-27T09:00:00.000Z", "2026-03-27T09:00:00.000Z", "2026-04-24T09:00:00.000Z"],
  "the last Friday of each month");
eq(iso(expand(monthly("20260113T090000Z", "FREQ=MONTHLY;BYDAY=2TU"), at("2026-01-01"), at("2026-04-01"))),
  ["2026-01-13T09:00:00.000Z", "2026-02-10T09:00:00.000Z", "2026-03-10T09:00:00.000Z"],
  "the second Tuesday of each month");
eq(iso(expand(monthly("20260131T090000Z", "FREQ=MONTHLY;BYMONTHDAY=31"), at("2026-01-01"), at("2026-07-01"))),
  ["2026-01-31T09:00:00.000Z", "2026-03-31T09:00:00.000Z", "2026-05-31T09:00:00.000Z"],
  "a monthly 31st skips the months that have none");
eq(iso(expand(monthly("20240229T090000Z", "FREQ=YEARLY"), at("2024-01-01"), at("2033-01-01"))),
  ["2024-02-29T09:00:00.000Z", "2028-02-29T09:00:00.000Z", "2032-02-29T09:00:00.000Z"],
  "a yearly 29 February only falls on leap years");
eq(iso(expand(monthly("20261126T090000Z", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), at("2026-01-01"), at("2029-01-01"))),
  ["2026-11-26T09:00:00.000Z", "2027-11-25T09:00:00.000Z", "2028-11-23T09:00:00.000Z"],
  "BYMONTH plus an ordinal BYDAY: the fourth Thursday of November");

// 2026-01-04 is a Sunday, so the two week starts disagree about which
// fortnight it belongs to.
const fortnight = (wkst: string) =>
  one(`UID:w\r\nDTSTART:20260104T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=${wkst}`);
eq(iso(expand(fortnight("SU"), at("2026-01-01"), at("2026-02-01"))),
  ["2026-01-04T09:00:00.000Z", "2026-01-06T09:00:00.000Z", "2026-01-18T09:00:00.000Z", "2026-01-20T09:00:00.000Z"],
  "WKST=SU keeps Sunday and Tuesday in the same fortnight");
eq(iso(expand(fortnight("MO"), at("2026-01-01"), at("2026-02-01"))),
  ["2026-01-04T09:00:00.000Z", "2026-01-13T09:00:00.000Z", "2026-01-18T09:00:00.000Z", "2026-01-27T09:00:00.000Z"],
  "WKST=MO splits them across two");

eq(iso(expand(one("UID:r\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=WEEKLY\r\nRDATE:20260103T090000Z\r\nEXDATE:20260108T090000Z"),
  at("2026-01-01"), at("2026-01-20"))),
  ["2026-01-01T09:00:00.000Z", "2026-01-03T09:00:00.000Z", "2026-01-15T09:00:00.000Z"],
  "an RDATE adds a one-off, and an EXDATE still removes a scheduled instance");
eq(iso(expand(one("UID:d\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=WEEKLY\r\nRDATE:20260101T090000Z"),
  at("2026-01-01"), at("2026-01-05"))),
  ["2026-01-01T09:00:00.000Z"],
  "an RDATE duplicating a rule occurrence is emitted once");

eq(expand(one("UID:p\r\nDTSTART:20200101T090000Z\r\nRRULE:FREQ=DAILY"),
  at("2020-01-01"), at("2025-01-01")).length, 1827,
  "an endless daily rule is bounded by the window, not by a cap");

// ----------------------------------------------------------------- all-day

const trip = one("UID:trip\r\nSUMMARY:Lisbon\r\nDTSTART;VALUE=DATE:20261212\r\nDTEND;VALUE=DATE:20261215");
const lisbon = expand(trip, at("2026-12-01"), at("2027-01-01"))[0]!;

eq([trip.allDay, trip.zone], [true, null], "an all-day event is floating");
eq(lisbon.start.getTime(), new Date(2026, 11, 12).getTime(), "it starts at local midnight");
eq(lisbon.end.getTime(), new Date(2026, 11, 15).getTime(),
  "an all-day DTEND is EXCLUSIVE, so 12-15 December covers three days");
eq(expand(trip, day(2026, 12, 13), day(2026, 12, 14)).length, 1,
  "and a window inside it still sees it: the test is intersection, not containment");
eq(expand(trip, day(2026, 12, 15), day(2026, 12, 16)).length, 0, "but the exclusive end is not covered");

const oneDay = one("UID:o\r\nDTSTART;VALUE=DATE:20261212");
eq(oneDay.durationMs, 86_400_000, "an all-day event with no DTEND lasts one day");
eq(one("UID:i\r\nDTSTART:20261212T100000Z").durationMs, 0,
  "a timed event with no end is an instant; the views floor the height, not the engine");
eq(one("UID:v\r\nDTSTART:20261212T100000Z\r\nDURATION:PT90M").durationMs, 5_400_000, "DURATION is used when DTEND is absent");

// --------------------------------------------------------------- overrides

const moved =
  "BEGIN:VEVENT\r\nUID:standup@google.com\r\n" +
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20261020T100000\r\n" +
  "DTSTART;TZID=Europe/Amsterdam:20261020T140000\r\n" +
  "DTEND;TZID=Europe/Amsterdam:20261020T153000\r\n" +
  "SUMMARY:Standup (moved)\r\nSEQUENCE:1\r\nEND:VEVENT";
const master =
  "BEGIN:VEVENT\r\nUID:standup@google.com\r\n" +
  "DTSTART;TZID=Europe/Amsterdam:20261006T100000\r\n" +
  "DTEND;TZID=Europe/Amsterdam:20261006T110000\r\n" +
  "RRULE:FREQ=WEEKLY;BYDAY=TU\r\nSUMMARY:Standup\r\nEND:VEVENT";

const withOverride = groupByUid(parseIcs(wrap(`${master}\r\n${moved}`)).events);
eq(withOverride.length, 1, "a master and its override are one series");
eq(withOverride[0]!.overrides.length, 1, "with the override attached");

const movedWeek = expandSeries(withOverride[0]!, at("2026-10-19"), at("2026-10-21"));
eq(movedWeek.length, 1, "the replaced instance does not double up");
eq(movedWeek[0]!.start.toISOString(), "2026-10-20T12:00:00.000Z", "the override wins at its new time");
eq(movedWeek[0]!.event.summary, "Standup (moved)", "and brings its own title");

const cancelled = groupByUid(parseIcs(wrap(
  `${master}\r\nBEGIN:VEVENT\r\nUID:standup@google.com\r\n` +
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20261020T100000\r\nDTSTART;TZID=Europe/Amsterdam:20261020T100000\r\n" +
  "STATUS:CANCELLED\r\nEND:VEVENT",
)).events);
eq(expandSeries(cancelled[0]!, at("2026-10-19"), at("2026-10-21")).length, 0,
  "a CANCELLED override deletes that one instance");
eq(expandSeries(withOverride[0]!, at("2026-10-19"), at("2026-10-20")).length, 0,
  "an instance moved out of the window is still suppressed where it was");
eq(expandSeries(withOverride[0]!, at("2026-10-20T13:00:00Z"), at("2026-10-20T14:00:00Z")).length, 1,
  "and appears where it moved to, even though the rule never lands there");

const orphan = groupByUid(parseIcs(wrap(moved)).events);
eq(orphan.length, 1, "an override with no master is promoted rather than dropped");
eq(expandSeries(orphan[0]!, at("2026-10-19"), at("2026-10-21")).length, 1, "and still renders");

// ------------------------------------------------------------------- parse

const google = parseIcs(wrap(
  "X-WR-CALNAME:Thijmen\r\nREFRESH-INTERVAL;VALUE=DURATION:PT4H\r\n" + master,
));
eq([google.name, google.ttlMinutes], ["Thijmen", 240], "the calendar name and its refresh interval");
eq(parseIcs(wrap("X-PUBLISHED-TTL:PT1H\r\n" + master)).ttlMinutes, 60, "X-PUBLISHED-TTL is the fallback");

const outlook = parseIcs(wrap(
  "BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\n" +
  "TZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n" +
  "BEGIN:VEVENT\r\nUID:040000008200E00074C5B7101A82E008\r\nSUMMARY:Sprint review\r\n" +
  "DTSTART;TZID=W. Europe Standard Time:20261112T140000\r\n" +
  "DTEND;TZID=W. Europe Standard Time:20261112T150000\r\n" +
  "X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\n" +
  "BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nSUMMARY:THIS MUST NOT LEAK\r\nEND:VALARM\r\n" +
  "END:VEVENT",
));
eq(outlook.events.length, 1, "a VTIMEZONE is not an event");
eq(outlook.events[0]!.summary, "Sprint review", "a VALARM's own SUMMARY does not leak into the event");
eq(expand(outlook.events[0]!, at("2026-11-01"), at("2026-12-01"))[0]!.start.toISOString(),
  "2026-11-12T13:00:00.000Z", "and the Windows TZID resolved to real CET");

eq(parseIcs("").events, [], "an empty feed");
eq(parseIcs("not an ics file at all").events, [], "a feed that isn't one");
eq(parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:truncated").events, [],
  "a file truncated mid-event never closes it, so nothing is emitted");
eq(parseIcs(wrap("BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:no start\r\nEND:VEVENT")).events, [],
  "an event with no DTSTART is skipped");
eq(one("DTSTART:20261212T100000Z\r\nSUMMARY:anonymous").uid.startsWith("no-uid-"), true,
  "a missing UID is synthesised rather than losing the event");
eq(one("UID:s\r\nDTSTART:20261212T100000Z\r\nURL:http://x.test/a").url, "",
  "a non-https URL is dropped: openExternal would refuse it anyway");

eq([parseDuration("PT1H30M"), parseDuration("P1DT2H"), parseDuration("-PT15M"), parseDuration("P1W")],
  [5_400_000, 93_600_000, -900_000, 604_800_000], "ISO 8601 durations");
eq([parseDuration("nonsense"), parseDuration("P")], [null, null], "and what isn't one");

// ------------------------------------------------------------------- query

const src = (id: string, hue: number, body: string, hidden?: boolean) => ({
  id, hue, name: id, hidden, events: parseIcs(wrap(body)).events,
});
const work = src("work", 10, "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Alpha\r\nDTSTART:20261112T100000Z\r\nDTEND:20261112T110000Z\r\nEND:VEVENT");
const home = src("home", 200, "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Beta\r\nDTSTART:20261112T093000Z\r\nDTEND:20261112T100000Z\r\nEND:VEVENT");

const merged = occurrencesIn([work, home], at("2026-11-12"), at("2026-11-13"));
eq(merged.map((o) => o.sourceId), ["home", "work"], "sources merge in time order");
eq(merged.map((o) => o.hue), [200, 10], "each occurrence carries its source's colour");
eq(occurrencesIn([work, { ...home, hidden: true }], at("2026-11-12"), at("2026-11-13")).length, 1,
  "a hidden source contributes nothing");
eq(occurrencesIn([work, { ...work, id: "copy" }], at("2026-11-12"), at("2026-11-13")).length, 2,
  "the same UID in two subscriptions is two occurrences, not one");
eq(occurrencesIn([src("x", 0, "BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261112T100000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT")],
  at("2026-11-12"), at("2026-11-13")).length, 0, "a cancelled event is not shown");

const sameDay = occurrencesIn([src("s", 0,
  "BEGIN:VEVENT\r\nUID:t\r\nSUMMARY:Timed\r\nDTSTART:20261112T000000Z\r\nDTEND:20261112T010000Z\r\nEND:VEVENT\r\n" +
  "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Day\r\nDTSTART;VALUE=DATE:20261112\r\nEND:VEVENT")],
  at("2026-11-11"), at("2026-11-14"));
eq(sameDay.filter((o) => o.allDay).length, 1, "an all-day event is returned alongside timed ones");
eq(occurrencesIn([work], at("2026-11-13"), at("2026-11-12")), [], "a backwards window is empty, not an error");

console.log(`calendar/ics: ${count} checks passed`);
