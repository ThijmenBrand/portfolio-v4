// An area's overview: Today for the area's courses and projects only -- what
// to do now, beside the day or week -- and a card per course and project with
// its next session, its open todos and how far along its goals are.
import { deadlineAt, deadlineState, type Todo } from "../todo/store.ts";
import { composer } from "./composer.ts";
import { editArea, editProject } from "./dialogs.ts";
import { gridDays, renderGrid } from "./grid.ts";
import { app, goalsOf, isEnded, partsOf, sessionsFor, todosInArea } from "./state.ts";
import type { Area, Project } from "./store.ts";
import { dayLists, daySections, deadlinesAhead, open, rangeSwitch } from "./today.ts";
import { backButton, button, dot, dueChip, el, fmtFull, fmtTime, fmtWeekday, heading, hueColor, ICONS, withIcon } from "./ui.ts";

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

/** Nothing in the area yet: what it's for, and how to start. */
function renderEmpty(page: HTMLElement, area: Area): void {
  const box = el("div", "empty-state is-page");
  const swatch = el("span", "rail-swatch is-big");
  swatch.style.background = hueColor(area.hue);
  box.append(
    swatch,
    el("h2", "", `Nothing in ${area.name} yet`),
    el("p", "", "Add a course (it finds its lectures in your calendar by its code) or a project. Each gets its shortcuts, goals, todos and notes."),
  );
  const actions = el("div", "empty-actions");
  actions.append(
    button("button primary", withIcon(ICONS.plus, "New course or project"), () => editProject(undefined, area.id)),
    button("button", withIcon(ICONS.gear, "Area settings"), () => editArea(area)),
  );
  box.append(actions);
  page.replaceChildren(box);
}

export function renderArea(page: HTMLElement, area: Area): void {
  const now = new Date();
  const projects = app.projects.data.projects.filter((project) => project.area === area.id);
  const active = projects.filter((project) => !isEnded(project, now));
  if (!projects.length) return renderEmpty(page, area);
  const ids = new Set(projects.map((project) => project.id));
  const inArea = (todo: Todo): boolean => todo.project !== undefined && ids.has(todo.project);
  const todos = todosInArea(area.id);
  const lists = dayLists(todos, now);

  const head = el("header", "page-head");
  head.append(backButton(area.name, () => app.go(app.route, "list")));
  const titles = el("div", "page-titles");
  const h1 = el("h1");
  const swatch = el("span", "rail-swatch");
  swatch.style.background = hueColor(area.hue);
  h1.append(swatch, el("span", "", area.name));
  const courses = active.filter((project) => project.kind === "course").length;
  titles.append(
    h1,
    el(
      "p",
      "page-sub",
      [
        fmtFull(now),
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
  head.append(titles, rangeSwitch(), settings);

  const left = el("div", "page-main");
  left.append(composer({ placeholder: "Add a todo, then # to file it", today: true }));
  const none = el("div", "empty-state");
  none.append(el("h2", "", `Nothing for today in ${area.name}`), el("p", "", "Plan something on today, or drag a todo onto the calendar."));
  left.append(...daySections(lists, now, none));

  const cards = el("section", "group-list");
  cards.append(heading("Courses and projects"));
  const grid = el("div", "area-cards");
  // Courses first, as the list has them.
  for (const project of [...active].sort((a, b) => Number(a.kind === "project") - Number(b.kind === "project"))) {
    grid.append(projectCard(project, now));
  }
  if (!active.length) cards.append(el("p", "empty-line", "Every course and project here has ended."));
  else cards.append(grid);
  left.append(cards);

  const side = el("aside", "page-side");
  const gridBox = el("div", "grid-box");
  side.append(gridBox, deadlinesAhead(now, 30, todos));
  renderGrid(gridBox, {
    days: gridDays(now, app.todayRange === "day" ? 1 : 7),
    now,
    hourPx: app.todayRange === "day" ? 44 : 34,
    onOpen: open,
    only: inArea,
  });

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, body);
}
