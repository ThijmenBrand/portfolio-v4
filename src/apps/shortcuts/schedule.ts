// Which space is on when: each space has rules (days + a time window), the
// first space in tab order with a matching rule wins, else the default space.

export interface Rule {
  /** Days the window starts on, as Date.getDay(): 0 is Sunday. */
  days: number[];
  /** "HH:MM". to <= from runs past midnight; from === to is the whole day. */
  from: string;
  to: string;
}

export interface Scheduled {
  id: string;
  rules: Rule[];
}

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const DAY = 24 * 60;

export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function ruleMatches(rule: Rule, day: number, minute: number): boolean {
  const from = minutesOf(rule.from);
  const to = minutesOf(rule.to);
  if (from < to) return rule.days.includes(day) && minute >= from && minute < to;
  // Past midnight: the part after 00:00 belongs to the day the window started.
  return (
    (rule.days.includes(day) && minute >= from) ||
    (rule.days.includes((day + 6) % 7) && minute < to)
  );
}

/** The space a rule puts on at this moment, or undefined when none does. */
export function ruleSpaceAt(spaces: Scheduled[], day: number, minute: number): string | undefined {
  return spaces.find((space) => space.rules.some((rule) => ruleMatches(rule, day, minute)))?.id;
}

export function scheduledAt(spaces: Scheduled[], fallback: string, date: Date): string {
  return ruleSpaceAt(spaces, date.getDay(), date.getHours() * 60 + date.getMinutes()) ?? fallback;
}

/** When the scheduled space next changes, or null if it never does. */
export function nextChange(spaces: Scheduled[], fallback: string, date: Date): Date | null {
  const now = scheduledAt(spaces, fallback, date);
  const t = new Date(date);
  t.setSeconds(0, 0);
  // ponytail: minute-by-minute scan of one week, ~10k checks; fine for a handful of rules
  for (let i = 0; i < 7 * DAY; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (scheduledAt(spaces, fallback, t) !== now) return new Date(t);
  }
  return null;
}
