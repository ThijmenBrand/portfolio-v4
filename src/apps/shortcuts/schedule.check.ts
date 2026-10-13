// Self-check for schedule.ts: `node src/apps/shortcuts/schedule.check.ts` (or `pnpm check`).
import { nextChange, scheduledAt } from "./schedule.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const spaces = [
  { id: "work", rules: [{ days: [1, 2], from: "08:30", to: "17:30" }] },
  { id: "uni", rules: [{ days: [3, 4, 5], from: "08:30", to: "18:00" }] },
  {
    id: "home",
    rules: [
      { days: [1, 2, 3, 4, 5], from: "18:00", to: "02:00" },
      { days: [6, 0], from: "00:00", to: "00:00" },
    ],
  },
];
// 2026-10-12 is a Monday.
const at = (day: number, time: string) => new Date(`2026-10-${String(11 + day).padStart(2, "0")}T${time}:00`);
const on = (date: Date) => scheduledAt(spaces, "general", date);

eq(on(at(1, "09:00")), "work", "Monday daytime is work");
eq(on(at(1, "08:29")), "general", "before any rule: default");
eq(on(at(1, "17:30")), "general", "end is exclusive");
eq(on(at(3, "12:00")), "uni", "Wednesday daytime is uni");
eq(on(at(1, "20:00")), "home", "evening");
eq(on(at(2, "01:30")), "home", "past midnight belongs to the evening before");
eq(on(at(2, "02:00")), "general", "after the overnight window");
eq(on(at(6, "01:00")), "home", "Friday night runs into Saturday, and Saturday is all day");
eq(on(at(7, "23:59")), "home", "Sunday all day");
eq(nextChange(spaces, "general", at(1, "09:15"))?.toTimeString().slice(0, 5), "17:30", "next change: end of work");
eq(nextChange([], "general", at(1, "09:15")), null, "no rules: never changes");

console.log(`schedule: ${count} checks passed`);
