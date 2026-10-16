// Self-check for layout.ts: `node src/apps/calendar/layout.check.ts` (or `pnpm check`).
import { columnLayout, minutesInto, packLanes } from "./layout.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const hhmm = (h: number, m = 0) => h * 60 + m;
const span = (from: number, to: number) => ({ start: hhmm(from), end: hhmm(to) });
/** col/span/total as a compact string per box, or "-" when hidden. */
const shape = (input: { start: number; end: number }[], maxCols?: number) =>
  columnLayout(input, maxCols).placed.map((box) =>
    box ? `${box.col}/${box.span}/${box.total}` : "-",
  );

eq(shape([span(9, 10), span(11, 12)]), ["0/1/1", "0/1/1"],
  "events that don't overlap each take the full width");

eq(shape([span(9, 10), span(9, 10)]), ["0/1/2", "1/1/2"],
  "two events at the same time split the day in half");

eq(shape([span(9, 11), span(9, 10), span(10, 11)]), ["0/1/2", "1/1/2", "1/1/2"],
  "a long event keeps column 0 and two short ones share column 1");

eq(shape([span(9, 12), span(9, 10), span(10, 11), span(11, 12), { start: hhmm(9), end: hhmm(9, 30) }]),
  ["0/1/3", "1/1/3", "1/2/3", "1/2/3", "2/1/3"],
  "the widening pass: the 10-11 and 11-12 boxes reach into the column the 9:00-9:30 event left free");

eq(shape([{ start: hhmm(9), end: hhmm(9) }]), ["0/1/1"],
  "a zero-length event still gets a box");
eq(shape([{ start: hhmm(9), end: hhmm(9, 5) }, { start: hhmm(9, 5), end: hhmm(9, 10) }]),
  ["0/1/2", "1/1/2"],
  "back-to-back five-minute events are laid out as overlapping, because that is how they draw");

const deep = columnLayout([span(9, 12), span(9, 12), span(9, 12), span(9, 12)], 2);
eq(deep.placed.map((box) => (box ? box.col : "-")), [0, 1, "-", "-"], "maxCols places what fits");
eq(deep.hidden, [2, 3], "and reports the rest for a +N chip");

eq(shape([span(9, 10), span(9, 10), span(14, 15)]), ["0/1/2", "1/1/2", "0/1/1"],
  "a later cluster is laid out independently of an earlier one");

eq(columnLayout([], 3), { placed: [], hidden: [] }, "no events, no boxes");

// ------------------------------------------------------------- lanes

const day = (from: number, to: number) => ({ start: from, end: to });

eq(packLanes([day(0, 3), day(1, 2), day(4, 5)]),
  [{ lane: 0, lanes: 2 }, { lane: 1, lanes: 2 }, { lane: 0, lanes: 1 }],
  "a three-day bar keeps lane 0 and a shorter one stacks under it");
eq(packLanes([day(0, 1), day(1, 2), day(2, 3)]),
  [{ lane: 0, lanes: 1 }, { lane: 0, lanes: 1 }, { lane: 0, lanes: 1 }],
  "consecutive days share one lane: the end is exclusive");
eq(packLanes([]), [], "nothing to pack");

// --------------------------------------------------------------- DST

// 2026-10-25 is 25 hours long in Amsterdam, and 2026-03-29 is 23.
const midnight = (y: number, mo: number, d: number) => new Date(y, mo - 1, d);
eq(minutesInto(midnight(2026, 11, 12), new Date(2026, 10, 12, 9, 30)), 570,
  "an ordinary day: 09:30 is 570 minutes in");
eq(minutesInto(midnight(2026, 11, 12), midnight(2026, 11, 13)) >= 1380, true,
  "and a day is at least 23 hours long whatever the zone does");

console.log(`calendar/layout: ${count} checks passed`);
