// The Todo app's todos, as occurrences the views can draw beside the feeds'
// events. A todo can put up to two things on the calendar:
//
//   its plan      when you mean to do it: at its time (for its length) when
//                 it has one, all day when it doesn't. A plan for a day now
//                 gone that isn't done yet is drawn twice -- faintly where it
//                 was missed, and all day on today, where it carried over to.
//   its deadline  when it is due: a flag at its time, or all day on its day.
//                 Only while the todo is open; a met deadline is old news.
//
// Undated todos have no place on a calendar.
//
// The todo travels on the occurrence (`todo`), and which of these it is on
// `todoPart`, which is what the views look for to draw a tick box or a flag
// instead of a plain chip.
import { addDays, dateKey, deadlineAt, parseDate, plannedAt, type Todo } from "../todo/store.ts";
import type { CalEvent } from "./parse.ts";
import type { Occurrence } from "./query.ts";

/** The sourceId every todo occurrence carries. Feed ids are 8 alphanumerics. */
export const TODO_SOURCE = "todo";
/**
 * How much of the day a timed todo with no length takes up in the week grid.
 * It is a moment rather than a stretch, so the views only print its start;
 * this is just enough height to read and to hit.
 */
export const TODO_MINUTES = 30;
/**
 * A timed deadline is an instant. It gets a minute so it overlaps the day it
 * is on; the week grid draws it as a line, never as a box of this height.
 */
const DEADLINE_MS = 60_000;

export type TodoPart = "plan" | "missed" | "carried" | "deadline";

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

/** Every todo occurrence overlapping [from, to), unsorted. */
export function todoOccurrences(
  todos: readonly Todo[],
  from: Date,
  to: Date,
  sourceName: string,
  now: Date = new Date(),
  /** The colour a todo is drawn in, from its project; undefined for the accent. */
  hueOfTodo: (todo: Todo) => number | undefined = () => undefined,
): Occurrence[] {
  const today = dateKey(now);
  const out: Occurrence[] = [];
  const add = (todo: Todo, part: TodoPart, key: string, start: Date, end: Date, allDay: boolean): void => {
    if (!(start < to && end > from)) return;
    const hue = hueOfTodo(todo);
    out.push({
      event: eventFor(todo, start, allDay, end.getTime() - start.getTime()),
      start,
      end,
      allDay,
      key,
      sourceId: TODO_SOURCE,
      sourceName,
      hue: 0, // drawn in the accent colour instead; see .is-todo in calendar.css
      todo,
      todoPart: part,
      ...(hue !== undefined && { todoHue: hue }),
    });
  };

  for (const todo of todos) {
    const plan = plannedAt(todo);
    if (plan) {
      const allDay = !todo.time;
      const end = allDay
        ? addDays(plan, 1)
        : new Date(plan.getTime() + (todo.minutes ?? TODO_MINUTES) * 60_000);
      const missed = !todo.done && todo.date! < today;
      add(todo, missed ? "missed" : "plan", todo.id, plan, end, allDay);
      if (missed) {
        const day = parseDate(today)!;
        add(todo, "carried", `${todo.id}:today`, day, addDays(day, 1), true);
      }
    }

    const due = deadlineAt(todo);
    if (due && !todo.done) {
      const allDay = !todo.deadlineTime;
      const end = allDay ? addDays(due, 1) : new Date(due.getTime() + DEADLINE_MS);
      add(todo, "deadline", `${todo.id}:due`, due, end, allDay);
    }
  }
  return out;
}
