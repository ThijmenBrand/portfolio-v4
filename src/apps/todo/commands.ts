// Todo's Spotlight commands (utils/commands.ts), run headless in a worker:
// nothing here may touch the DOM.
//
//   new <line>   add a todo; the line's whens are read by parseQuickAdd
//                (store.ts), and with none it has no plan
//   done <id>    tick one off (offered by search: the open todos whose
//                title has every word typed)
//
// It writes the same file the app does, the same read-modify-write way, so
// an open Todo window or Calendar picks it up from fs.changed.
import { commandMain, type CommandHandler, type SearchHandler } from "../../utils/commands";
import {
  dateKey,
  addDays,
  MAX_TODOS,
  newId,
  openTodos,
  parseDate,
  parseQuickAdd,
  saveProblem,
  type QuickAdd,
  type Todo,
} from "./store";

export const command: CommandHandler = async (os, id, input) => {
  if (id === "done") return done(os, input);
  if (id !== "new") return { error: `Todo has no command "${id}".` };

  const now = new Date();
  const { title, ...when } = parseQuickAdd(input, now);
  if (!title) return { error: "Say what the todo is." };

  const store = await openTodos(os);
  if (store.data.todos.length >= MAX_TODOS) {
    return { error: "The list is full. Clear some completed todos first." };
  }
  const todo: Todo = { id: newId(), title, done: false, ...when, createdAt: Date.now() };
  try {
    await store.update((data) => void data.todos.push(structuredClone(todo)));
  } catch (error) {
    return { error: saveProblem(error, store.backing) };
  }
  return { message: `Added “${title}” · ${describe(when, now)}` };
};

async function done(os: Parameters<CommandHandler>[0], id: string) {
  const store = await openTodos(os);
  const todo = store.data.todos.find((each) => each.id === id);
  if (!todo) return { error: "That todo is gone." };
  if (todo.done) return { message: `“${todo.title}” was already done` };
  const at = Date.now();
  try {
    await store.update((data) => {
      const latest = data.todos.find((each) => each.id === id);
      if (latest && !latest.done) Object.assign(latest, { done: true, doneAt: at });
    });
  } catch (error) {
    return { error: saveProblem(error, store.backing) };
  }
  return { message: `Done: “${todo.title}”` };
}

/** Open todos with every word typed in their title, soonest plan first. */
export const search: SearchHandler = async (os, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const now = new Date();
  const store = await openTodos(os);
  return store.data.todos
    .filter((todo) => !todo.done && words.every((word) => todo.title.toLowerCase().includes(word)))
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || (a.time ?? "").localeCompare(b.time ?? ""))
    .slice(0, 5)
    .map((todo) => ({
      title: todo.title,
      detail: describe(todo, now),
      command: "done",
      input: todo.id,
    }));
};

export const main = commandMain(command, search);

/** "today 14:00 · due Fri", "no plan". */
export function describe(when: Omit<QuickAdd, "title">, now: Date): string {
  const day = (key: string): string => {
    if (key === dateKey(now)) return "today";
    if (key === dateKey(addDays(now, 1))) return "tomorrow";
    const at = parseDate(key)!;
    const soon = at.getTime() - now.getTime() < 6 * 86_400_000;
    return at.toLocaleDateString("en-GB", soon ? { weekday: "short" } : { day: "numeric", month: "short" });
  };
  const parts: string[] = [];
  if (when.date) {
    const length = when.minutes ? ` for ${minutesLabel(when.minutes)}` : "";
    parts.push([day(when.date), when.time].filter(Boolean).join(" ") + length);
  }
  if (when.deadline) parts.push(`due ${[day(when.deadline), when.deadlineTime].filter(Boolean).join(" ")}`);
  return parts.length ? parts.join(" · ") : "no plan";
}

function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h${String(m).padStart(2, "0")}` : h ? `${h}h` : `${m}m`;
}
