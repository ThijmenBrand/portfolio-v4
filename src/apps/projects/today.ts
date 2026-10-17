// The two pages that cut across every area: Today (what to do now, beside a
// calendar of the day or week) and Upcoming (the next two weeks, day by day).
// An area's overview (area.ts) is Today again, for that area's todos only.
import {
  addDays,
  dateKey,
  daysBetween,
  deadlineAt,
  deadlineState,
  isForToday,
  type Todo,
} from "../todo/store.ts";
import { composer } from "./composer.ts";
import { editTodo } from "./dialogs.ts";
import { gridDays, renderGrid } from "./grid.ts";
import { app, goalOf, partsOf, projectOf } from "./state.ts";
import {
  backButton,
  button,
  el,
  empty,
  fmtDayMonth,
  fmtFull,
  fmtWeekday,
  heading,
  hueColor,
  projectTag,
  todoRow,
} from "./ui.ts";

export const open = (todo: Todo): void => {
  if (todo.goal && projectOf(todo)) app.go({ view: "goal", id: todo.project!, goal: todo.id }, "page");
  else editTodo(todo);
};

function section(title: string, todos: Todo[], now: Date, extra: { noDay?: boolean; late?: boolean } = {}): HTMLElement | null {
  if (!todos.length) return null;
  const node = el("section", "group-list");
  const head = heading(title);
  if (extra.late) head.classList.add("is-late");
  node.append(head);
  for (const todo of todos) node.append(todoRow(todo, now, { tag: true, goal: true, noDay: extra.noDay, onOpen: open }));
  return node;
}

const byTime = (a: Todo, b: Todo): number =>
  (a.date ?? "").localeCompare(b.date ?? "") ||
  Number(Boolean(a.time)) - Number(Boolean(b.time)) ||
  (a.time ?? "").localeCompare(b.time ?? "") ||
  (deadlineAt(a)?.getTime() ?? Infinity) - (deadlineAt(b)?.getTime() ?? Infinity);

/** Goal and todo deadlines coming up, with how far along each goal is. */
export function deadlinesAhead(now: Date, days: number, todos: readonly Todo[] = app.todos.data.todos): HTMLElement {
  const node = el("section", "deadlines");
  node.append(heading("Deadlines ahead"));
  const soon = todos
    .filter((todo) => {
      // A part's deadline is its goal's business; one whose goal is gone is a todo again.
      if (todo.done || goalOf(todo)) return false;
      const at = deadlineAt(todo);
      return at !== null && daysBetween(now, at) >= 0 && daysBetween(now, at) <= days;
    })
    .sort((a, b) => deadlineAt(a)!.getTime() - deadlineAt(b)!.getTime());
  if (!soon.length) node.append(empty(`Nothing due in the next ${days} days.`));
  for (const todo of soon.slice(0, 8)) {
    const at = deadlineAt(todo)!;
    const row = button("deadline", "", () => open(todo));
    const day = el("span", `deadline-day is-${deadlineState(todo, now) ?? "later"}`);
    day.append(el("small", "", fmtWeekday(at)), el("b", "", String(at.getDate())), el("small", "", at.toLocaleDateString(undefined, { month: "short" })));
    const what = el("span", "deadline-what");
    what.append(el("b", "", todo.title));
    const project = projectOf(todo);
    const meta = el("span", "deadline-meta");
    if (project) meta.append(projectTag(project));
    if (todo.goal) {
      const parts = partsOf(todo);
      const planned = parts.filter((part) => part.date || part.done).length;
      const done = parts.filter((part) => part.done).length;
      meta.append(
        el("span", planned < parts.length || !parts.length ? "is-warn" : "", parts.length ? `${done}/${parts.length} done · ${parts.length - planned ? `${parts.length - planned} not planned` : "all planned"}` : "no parts yet"),
      );
      const bar = el("span", "progress");
      const fill = el("i");
      fill.style.width = `${parts.length ? (done / parts.length) * 100 : 0}%`;
      if (project) fill.style.background = hueColor(project.hue);
      bar.append(fill);
      what.append(meta, bar);
    } else {
      what.append(meta);
    }
    row.append(day, what);
    node.append(row);
  }
  return node;
}

/** What's on for today among these todos, in the sections Today lists them in. */
export function dayLists(all: readonly Todo[], now: Date) {
  const today = dateKey(now);
  const todos = all.filter((todo) => !todo.done);
  const late = todos.filter((todo) => deadlineState(todo, now) === "late").sort(byTime);
  const lateIds = new Set(late.map((todo) => todo.id));
  const forToday = todos.filter((todo) => !lateIds.has(todo.id) && !todo.goal && isForToday(todo, today));
  return {
    late,
    planned: forToday.filter((todo) => todo.date === today).sort(byTime),
    carried: forToday.filter((todo) => todo.date && todo.date < today).sort(byTime),
    dueOnly: forToday.filter((todo) => !todo.date),
    doneToday: all.filter((todo) => todo.done && todo.doneAt && dateKey(new Date(todo.doneAt)) === today),
    count: late.length + forToday.length,
  };
}

/** The sections of `dayLists`, or `none` when there's nothing to do, then what's done today. */
export function daySections(lists: ReturnType<typeof dayLists>, now: Date, none: HTMLElement): HTMLElement[] {
  const sections = [
    section("Overdue", lists.late, now, { late: true }),
    section("Planned for today", lists.planned, now, { noDay: true }),
    section("Carried over", lists.carried, now),
    section("Due today, not planned", lists.dueOnly, now),
  ].filter((node): node is HTMLElement => node !== null);
  if (!sections.length) sections.push(none);
  const done = section(`Done today · ${lists.doneToday.length}`, lists.doneToday, now, { noDay: true });
  if (done) {
    done.classList.add("is-done-list");
    sections.push(done);
  }
  return sections;
}

/** The Day / Week switch above the calendar beside today's todos. */
export function rangeSwitch(): HTMLElement {
  const range = el("div", "segmented is-small");
  range.setAttribute("role", "radiogroup");
  range.setAttribute("aria-label", "Calendar shows");
  for (const [value, label] of [["day", "Day"], ["week", "Week"]] as const) {
    const pick = button("segment", label, () => {
      app.todayRange = value;
      app.render();
    });
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(app.todayRange === value));
    range.append(pick);
  }
  return range;
}

export function renderToday(page: HTMLElement): void {
  const now = new Date();
  const lists = dayLists(app.todos.data.todos, now);

  const head = el("header", "page-head");
  head.append(backButton("Areas", () => app.go(app.route, "rail")));
  const titles = el("div", "page-titles");
  titles.append(el("h1", "", "Today"));
  titles.append(
    el("p", "page-sub", [fmtFull(now), lists.count ? `${lists.count} to do` : "nothing to do", lists.late.length ? `${lists.late.length} overdue` : ""].filter(Boolean).join(" · ")),
  );
  head.append(titles, rangeSwitch());

  const left = el("div", "page-main");
  left.append(composer({ placeholder: "Add a todo, then # to file it", today: true }));
  const none = el("div", "empty-state");
  none.append(el("h2", "", "Nothing for today"), el("p", "", "Plan something on today, or drag a todo onto the calendar."));
  left.append(...daySections(lists, now, none));

  const side = el("aside", "page-side");
  const gridBox = el("div", "grid-box");
  side.append(gridBox, deadlinesAhead(now, 30));
  renderGrid(gridBox, {
    days: gridDays(now, app.todayRange === "day" ? 1 : 7),
    now,
    hourPx: app.todayRange === "day" ? 44 : 34,
    onOpen: open,
  });

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, body);
}

export function renderUpcoming(page: HTMLElement): void {
  const now = new Date();
  const horizon = 14;
  const todos = app.todos.data.todos.filter((todo) => !todo.done);

  const head = el("header", "page-head");
  head.append(backButton("Areas", () => app.go(app.route, "rail")));
  const titles = el("div", "page-titles");
  titles.append(el("h1", "", "Upcoming"), el("p", "page-sub", "The next two weeks, then the rest"));
  head.append(titles);

  const left = el("div", "page-main");
  left.append(composer({ placeholder: "Add a todo, then # to file it" }));
  let shown = 0;
  for (let i = 1; i <= horizon; i++) {
    const day = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), i);
    const key = dateKey(day);
    const planned = todos.filter((todo) => todo.date === key && !todo.goal).sort(byTime);
    const due = todos.filter((todo) => todo.deadline === key && todo.date !== key);
    if (!planned.length && !due.length) continue;
    shown++;
    const node = el("section", "group-list day-list");
    node.append(heading(i === 1 ? `Tomorrow · ${fmtDayMonth(day)}` : fmtDayMonth(day)));
    for (const todo of planned) node.append(todoRow(todo, now, { tag: true, goal: true, noDay: true, onOpen: open }));
    for (const todo of due) {
      const row = todoRow(todo, now, { tag: true, goal: true, dueFirst: true, onOpen: open });
      row.classList.add("is-due-row");
      node.append(row);
    }
    left.append(node);
  }
  const lastDay = dateKey(addDays(now, horizon));
  const later = todos.filter((todo) => todo.date && todo.date > lastDay && !todo.goal).sort(byTime);
  const unplanned = todos
    .filter((todo) => !todo.date && !todo.goal && todo.deadline)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  const laterNode = section("Later", later, now);
  const unplannedNode = section("Has a deadline, not planned", unplanned, now);
  if (laterNode) left.append(laterNode);
  if (unplannedNode) left.append(unplannedNode);
  if (!shown && !laterNode && !unplannedNode) {
    const none = el("div", "empty-state");
    none.append(el("h2", "", "Nothing coming up"), el("p", "", "Todos planned after today, and deadlines, show here."));
    left.append(none);
  }

  const side = el("aside", "page-side");
  const gridBox = el("div", "grid-box");
  side.append(heading("This week"), gridBox);
  renderGrid(gridBox, { days: gridDays(now, 7), now, hourPx: 34, onOpen: open });

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, body);
}

