// Changes to the todo list made from this app. Every one goes through the
// Todo app's store (a read-modify-write of the latest file), so the Todo app
// and the Calendar, which write the same file, never lose an edit.
import { MAX_TODOS, newId, type Todo } from "../todo/store.ts";
import { app, todoById } from "./state.ts";

export interface NewTodo {
  title: string;
  project: string;
  parent?: string;
  goal?: boolean;
  date?: string;
  time?: string;
  minutes?: number;
  deadline?: string;
  deadlineTime?: string;
}

/** Adds a todo; returns its id. */
export function addTodo(fields: NewTodo): string {
  const todo: Todo = {
    id: newId(),
    title: fields.title.trim(),
    done: false,
    createdAt: Date.now(),
    project: fields.project,
    ...(fields.goal && { goal: true }),
    ...(fields.parent && { parent: fields.parent }),
    ...(fields.date && { date: fields.date }),
    ...(fields.date && fields.time && { time: fields.time }),
    ...(fields.date && fields.time && fields.minutes && { minutes: fields.minutes }),
    ...(fields.deadline && { deadline: fields.deadline }),
    ...(fields.deadline && fields.deadlineTime && { deadlineTime: fields.deadlineTime }),
  };
  if (app.todos.data.todos.length >= MAX_TODOS) {
    app.status(`That's the most todos the list can hold (${MAX_TODOS}).`);
    return todo.id;
  }
  app.save(
    app.todos.update((data) => {
      if (!data.todos.some((each) => each.id === todo.id)) data.todos.push(structuredClone(todo));
    }),
    "todos",
  );
  return todo.id;
}

/**
 * Writes the fields that differ between `before` (the copy the edit started
 * from) and `next` onto the latest copy -- only those, so a change made
 * meanwhile elsewhere (ticked off in the Calendar, say) to a field this edit
 * didn't touch survives it. Never id or createdAt.
 */
export function saveTodo(before: Todo, next: Todo): void {
  const fields = new Set([...Object.keys(before), ...Object.keys(next)] as (keyof Todo)[]);
  fields.delete("id");
  fields.delete("createdAt");
  const changed = [...fields].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
  if (!changed.length) return;
  const patch = structuredClone(next);
  app.save(
    app.todos.update((data) => {
      const found = data.todos.find((each) => each.id === next.id);
      if (!found) return;
      const target = found as unknown as Record<string, unknown>;
      for (const key of changed) {
        if (patch[key] === undefined) delete target[key];
        else target[key] = structuredClone(patch[key]);
      }
    }),
    "todos",
  );
}

/**
 * Plans a todo on `date`. With `time` it is planned at that time (keeping
 * its length); with null its time is cleared; left out, it keeps its time.
 */
export function planTodo(id: string, date: string, time?: string | null): void {
  const todo = todoById(id);
  if (!todo || todo.done) return;
  app.save(
    app.todos.update((data) => {
      const found = data.todos.find((each) => each.id === id);
      if (!found) return;
      found.date = date;
      if (time === null) {
        delete found.time;
        delete found.minutes;
      } else if (time !== undefined) {
        found.time = time;
        found.minutes ??= 60;
      }
    }),
    "todos",
  );
}

/** Removes todos, with Undo putting them back where they were. */
export function removeTodos(ids: readonly string[], message: string): void {
  const removed = app.todos.data.todos
    .map((todo, index) => ({ todo, index }))
    .filter(({ todo }) => ids.includes(todo.id));
  if (!removed.length) return;
  // Parts of a removed goal stay, as loose todos of the project; Undo puts them back in it.
  const orphaned = app.todos.data.todos
    .filter((todo) => todo.parent && ids.includes(todo.parent) && !ids.includes(todo.id))
    .map((todo) => ({ id: todo.id, parent: todo.parent! }));
  app.save(
    app.todos.update((data) => {
      data.todos = data.todos.filter((todo) => !ids.includes(todo.id));
      for (const todo of data.todos) if (orphaned.some((each) => each.id === todo.id)) delete todo.parent;
    }),
    "todos",
  );
  app.status(message, () => {
    app.save(
      app.todos.update((data) => {
        for (const { todo, index } of removed) {
          if (data.todos.some((each) => each.id === todo.id)) continue;
          data.todos.splice(Math.min(index, data.todos.length), 0, structuredClone(todo));
        }
        for (const { id, parent } of orphaned) {
          const part = data.todos.find((todo) => todo.id === id);
          if (part && !part.parent) part.parent = parent;
        }
      }),
      "todos",
    );
    app.render();
  });
}
