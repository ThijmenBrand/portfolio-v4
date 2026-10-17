// The Todo app's dated todos, as occurrences the views can draw beside the
// feeds' events. A todo with a time sits at that time of day; one without is
// an all-day item on its day. Undated todos have no place on a calendar.
//
// The todo travels on the occurrence (`todo`), which is what the views look
// for to draw a tick box instead of a plain chip.
import { dueAt, type Todo } from "../todo/store.ts";
import type { CalEvent } from "./parse.ts";
import type { Occurrence } from "./query.ts";

/** The sourceId every todo occurrence carries. Feed ids are 8 alphanumerics. */
export const TODO_SOURCE = "todo";
/**
 * How much of the day a timed todo takes up in the week grid. A todo is due
 * at a moment, not for a duration, so the views only ever print its start;
 * this is just enough height to read and to hit.
 */
export const TODO_MINUTES = 30;

function eventFor(todo: Todo, start: Date, allDay: boolean, durationMs: number): CalEvent {
  return {
    uid: todo.id,
    summary: todo.title,
    description: todo.notes ?? "",
    location: "",
    url: "",
    categories: [],
    status: "",
    transparent: false,
    sequence: 0,
    stamp: todo.createdAt,
    allDay,
    start: start.getTime(),
    durationMs,
    zone: null,
    rrule: null,
    exdate: [],
    rdate: [],
    recurrenceId: null,
  };
}

/** Every dated todo overlapping [from, to), unsorted. */
export function todoOccurrences(
  todos: readonly Todo[],
  from: Date,
  to: Date,
  sourceName: string,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const todo of todos) {
    const start = dueAt(todo);
    if (!start) continue;
    const allDay = !todo.time;
    const end = allDay
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
      : new Date(start.getTime() + TODO_MINUTES * 60_000);
    if (!(start < to && end > from)) continue;
    out.push({
      event: eventFor(todo, start, allDay, end.getTime() - start.getTime()),
      start,
      end,
      allDay,
      key: todo.id,
      sourceId: TODO_SOURCE,
      sourceName,
      hue: 0, // drawn in the accent colour instead; see .is-todo in calendar.css
      todo,
    });
  }
  return out;
}
