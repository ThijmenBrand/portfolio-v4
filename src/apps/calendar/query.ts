// What the views ask for: everything visible in a window, across every
// subscribed calendar, in the order it should be drawn.
import { expandSeries, groupByUid, type Instance } from "./expand.ts";
import type { CalEvent } from "./parse.ts";

export interface QuerySource {
  /** The app's own id for the subscription; travels onto every occurrence. */
  id: string;
  name: string;
  /** 0..359. The views turn it into oklch(). */
  hue: number;
  events: readonly CalEvent[];
  hidden?: boolean;
}

export interface Occurrence extends Instance {
  sourceId: string;
  sourceName: string;
  hue: number;
}

/** Longer windows are clamped rather than refused. */
export const MAX_WINDOW_MS = 5 * 365 * 86_400_000;

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * Sorted for rendering: by start, then all-day first, then longest first so
 * multi-day banners stack above the short events inside them, then by title.
 *
 * All-day first is scoped to a shared start instant, not global: all-day
 * events begin at local midnight and so already lead their own day, and a
 * global all-day-first sort would scramble chronology in the agenda.
 */
function compare(a: Occurrence, b: Occurrence): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    Number(b.allDay) - Number(a.allDay) ||
    b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime()) ||
    collator.compare(a.event.summary, b.event.summary) ||
    a.key.localeCompare(b.key)
  );
}

/** Never throws: one unreadable calendar must not blank the whole view. */
export function occurrencesIn(
  sources: readonly QuerySource[],
  from: Date,
  to: Date,
): Occurrence[] {
  const start = from.getTime();
  const end = Math.min(to.getTime(), start + MAX_WINDOW_MS);
  if (!(end > start)) return [];
  const until = new Date(end);

  const out: Occurrence[] = [];
  for (const source of sources) {
    if (source.hidden) continue;
    for (const series of groupByUid(source.events)) {
      // A cancelled master takes the whole series with it; a cancelled
      // override only removes its own instance, which expandSeries handles.
      if (series.master.status === "CANCELLED") continue;
      let instances: Instance[];
      try {
        instances = expandSeries(series, from, until);
      } catch {
        continue;
      }
      for (const instance of instances) {
        out.push({
          ...instance,
          sourceId: source.id,
          sourceName: source.name,
          hue: source.hue,
        });
      }
    }
  }
  return out.sort(compare);
}
