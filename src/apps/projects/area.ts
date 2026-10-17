// An area's overview: Today for the area only -- what to do now, and what's
// next in the area's own calendar, beside the next few days -- then the area's own todos, the ones in no project (an area
// needs no projects: Private can be just a list), and a card per course and
// project with its next session, its open todos and how far along its goals are.
import { deadlineAt, deadlineState, type Todo } from "../todo/store.ts";
import { composer } from "./composer.ts";
import { editArea, editProject } from "./dialogs.ts";
import { calendarPanel } from "./grid.ts";
import { app, areaEventsIn, areaTodos, goalsOf, isEnded, partsOf, sessionsFor, todosInArea } from "./state.ts";
import type { Area, Project } from "./store.ts";
import { dayLists, daySections, deadlinesAhead, open } from "./today.ts";
import { areaMark, backButton, button, dot, dueChip, el, fmtFull, fmtTime, fmtWeekday, heading, hueColor, ICONS, todoRow, withIcon } from "./ui.ts";

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The line under a project in the list: its next session, then its next deadline. */
export function listLine(project: Project, now: Date): HTMLElement {
  const line = el("span", "list-sub");
  const parts: (string | HTMLElement)[] = [];
  const sessions = sessionsFor(project);
  const next = sessions.find((session) => session.end > now);
  if (next && next.start.getTime() - now.getTime() < 7 * 86_400_000) {
    const on = next.start <= now;
    parts.push(`${next.type || "Session"} ${on ? "now" : `${fmtWeekday(next.start)} ${fmtTime(next.start)}`}`);
  }
  const due = app.todos.data.todos
    .filter((todo) => todo.project === project.id && !todo.done && todo.deadline)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!) || (a.deadlineTime ?? "").localeCompare(b.deadlineTime ?? ""))[0];
  if (due) {
    const state = deadlineState(due, now) ?? "later";
    const span = el("span", `is-${state}`);
    const at = new Date(`${due.deadline}T00:00`);
    span.textContent = state === "late" ? `${due.title} overdue` : `due ${at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
    parts.push(span);
  }
  if (!parts.length) parts.push(project.kind === "course" && !sessions.length ? "Not linked to a calendar" : "No deadlines");
  for (const [index, part] of parts.entries()) {
    if (index) line.append(" · ");
    line.append(part);
  }
  return line;
}

const byDeadline = (a: Todo, b: Todo): number =>
  (deadlineAt(a)?.getTime() ?? Infinity) - (deadlineAt(b)?.getTime() ?? Infinity);

/** A course or project at a glance; opens its page. */
function projectCard(project: Project, now: Date): HTMLElement {
  const card = button("area-card", "", () => app.go({ view: "project", id: project.id }));
  const todos = app.todos.data.todos.filter((todo) => todo.project === project.id && !todo.done && !todo.goal);
  const late = todos.filter((todo) => deadlineState(todo, now) === "late").length;

  const head = el("span", "area-card-head");
  const name = el("span", "list-name");
  name.append(dot(project.hue), el("span", "", project.code ? `${project.code} · ${project.name}` : project.name));
  const counts = el("span", "area-card-counts");
  counts.append(el("span", "", todos.length ? plural(todos.length, "todo") : "no todos"));
  if (late) counts.append(el("span", "is-late", `${late} overdue`));
  head.append(name, counts);
  card.append(head, listLine(project, now));

  const goals = goalsOf(project.id).filter((goal) => !goal.done).sort(byDeadline);
  for (const goal of goals.slice(0, 3)) {
    const parts = partsOf(goal);
    const done = parts.filter((part) => part.done).length;
    const row = el("span", "area-goal");
    row.append(el("span", "area-goal-title", goal.title));
    const bar = el("span", "progress");
    const fill = el("i");
    fill.style.width = `${parts.length ? (done / parts.length) * 100 : 0}%`;
    fill.style.background = hueColor(project.hue);
    bar.append(fill);
    row.append(bar, el("span", "count", parts.length ? `${done}/${parts.length}` : "no parts"));
    const due = dueChip(goal, now);
    if (due) row.append(due);
    card.append(row);
  }
  if (goals.length > 3) card.append(el("span", "area-more", `and ${plural(goals.length - 3, "more goal")}`));
  return card;
}

/** Done today, or open and on today's list: shown in the day's sections already. */
const onDayLists = (lists: ReturnType<typeof dayLists>): Set<string> =>
  new Set([...lists.late, ...lists.planned, ...lists.carried, ...lists.dueOnly, ...lists.doneToday].map((todo) => todo.id));

/** The area's own todos, the ones in no project, that today's sections don't list. */
function ownTodos(area: Area, lists: ReturnType<typeof dayLists>, now: Date): HTMLElement | null {
  const above = onDayLists(lists);
  const own = areaTodos(area.id);
  const rest = own.filter((todo) => !above.has(todo.id));
  const doneCount = rest.filter((todo) => todo.done).length;
  if (!rest.length) return null;
  const node = el("section", "group-list");
  const toggleDone = doneCount
    ? button("link", app.showDone ? "Hide done" : `Show done (${doneCount})`, () => {
        app.showDone = !app.showDone;
        app.render();
      })
    : "";
  // Under today's sections these are the rest; on their own, simply the area's todos.
  node.append(heading(own.some((todo) => above.has(todo.id)) ? "Other todos" : "Todos", toggleDone));
  const order = (todo: Todo): string => `${Number(todo.done)}${todo.date ?? "9999"}${todo.time ?? ""}${todo.deadline ?? "9999"}`;
  const shown = rest.filter((todo) => !todo.done || app.showDone).sort((a, b) => order(a).localeCompare(order(b)));
  for (const todo of shown) node.append(todoRow(todo, now, { onOpen: open }));
  if (!shown.length) node.append(el("p", "empty-line", "All done."));
  return node;
}

/** The area's courses and projects as cards, and a card to add one. */
function projectCards(area: Area, projects: Project[], now: Date): HTMLElement {
  const active = projects.filter((project) => !isEnded(project, now));
  const node = el("section", "group-list");
  node.append(heading("Courses and projects"));
  if (!projects.length) {
    node.append(
      el("p", "empty-line", "For bigger things: a course finds its lectures in your calendar, a project gets goals, shortcuts and notes."),
    );
  } else if (!active.length) {
    node.append(el("p", "empty-line", "Every course and project here has ended."));
  }
  const grid = el("div", "area-cards");
  // Courses first, as the list has them.
  for (const project of [...active].sort((a, b) => Number(a.kind === "project") - Number(b.kind === "project"))) {
    grid.append(projectCard(project, now));
  }
  grid.append(button("area-card is-add", withIcon(ICONS.plus, "New course or project"), () => editProject(undefined, area.id)));
  node.append(grid);
  return node;
}

/** What's on next today in the area's own calendar: "Standup now", "Review at 14:00", or "". */
function nextEvent(area: Area, now: Date): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const next = areaEventsIn(area, now, midnight).find((each) => each.end > now);
  if (!next) return "";
  const title = next.event.summary || "(no title)";
  return next.start <= now ? `${title} now` : `${title} at ${fmtTime(next.start)}`;
}

export function renderArea(page: HTMLElement, area: Area): void {
  const now = new Date();
  const projects = app.projects.data.projects.filter((project) => project.area === area.id);
  const active = projects.filter((project) => !isEnded(project, now));
  const todos = todosInArea(area.id);
  const ids = new Set(todos.map((todo) => todo.id));
  const inArea = (todo: Todo): boolean => ids.has(todo.id);
  const lists = dayLists(todos, now);

  const head = el("header", "page-head");
  head.append(backButton(area.name, () => app.go(app.route, "list")));
  const titles = el("div", "page-titles");
  const h1 = el("h1");
  h1.append(areaMark(area), el("span", "", area.name));
  const courses = active.filter((project) => project.kind === "course").length;
  titles.append(
    h1,
    el(
      "p",
      "page-sub",
      [
        fmtFull(now),
        nextEvent(area, now),
        courses ? plural(courses, "course") : "",
        active.length - courses ? plural(active.length - courses, "project") : "",
        lists.count ? `${lists.count} to do today` : "nothing to do today",
        lists.late.length ? `${lists.late.length} overdue` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  const settings = button("icon-button", ICONS.gear, () => editArea(area));
  settings.setAttribute("aria-label", `${area.name} settings`);
  settings.title = "Area settings";
  head.append(titles, settings);

  const left = el("div", "page-main");
  left.append(
    composer({
      area: area.id,
      placeholder: active.length ? `Add a todo to ${area.name}, or # for a project` : `Add a todo to ${area.name}`,
      today: true,
    }),
  );
  const none = el("div", "empty-state");
  if (!todos.length && !projects.length) {
    none.append(
      el("h2", "", `${area.name} is empty`),
      el("p", "", `Add todos straight to ${area.name} above, no project needed. Start a course or project below when something needs goals, a schedule or notes.`),
    );
  } else {
    none.append(el("h2", "", `Nothing for today in ${area.name}`), el("p", "", "Plan something on today, or drag a todo onto the calendar."));
  }
  left.append(...daySections(lists, now, none, area.id));
  const own = ownTodos(area, lists, now);
  if (own) left.append(own);
  left.append(projectCards(area, projects, now));

  const side = el("aside", "page-side");
  side.append(calendarPanel({ now, onOpen: open, only: inArea }), deadlinesAhead(now, 30, todos, area.id));

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, body);
}
