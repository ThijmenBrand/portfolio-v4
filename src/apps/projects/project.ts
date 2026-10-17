// A course's or project's page, and a goal's.
//
// The project page is one scrolling page: its shortcuts, its goals (each with
// its parts, planned across the days before the deadline), its other todos
// and its notes -- beside its sessions, when it's a course, and a calendar of
// the coming days to plan in. A goal's page lays the days up to its deadline
// out side by side, to drag the parts onto.
import { guessName, hostOf, hueOf, initialOf, toUrl } from "../shortcuts/site";
import {
  addDays,
  dateKey,
  daysBetween,
  deadlineAt,
  deadlineState,
  MAX_NOTES,
  parseDate,
  plannedAt,
  plannedLate,
  type Todo,
} from "../todo/store.ts";
import { planTodo, saveTodo } from "./actions.ts";
import { composer } from "./composer.ts";
import { editProject, editTodo } from "./dialogs.ts";
import { draftOpenFor, goalDraft, openGoalDraft } from "./goaldraft.ts";
import { calendarPanel, gridDays } from "./grid.ts";
import { nextSession, summarize, type Session } from "./match.ts";
import { notesSection } from "./notes.ts";
import {
  app,
  areaById,
  currentProject,
  eventsIn,
  goalsOf,
  isEnded,
  looseOf,
  ownerOfEvent,
  partsOf,
  sessionsFor,
} from "./state.ts";
import { labelOf, MAX_SHORTCUTS, type Project } from "./store.ts";
import {
  backButton,
  button,
  dayLabel,
  dropTarget,
  dueChip,
  dueText,
  el,
  empty,
  fmtDayMonth,
  fmtTime,
  fmtWeekday,
  heading,
  hueColor,
  ICONS,
  lengthText,
  projectLabel,
  slotLine,
  todoRow,
  withIcon,
} from "./ui.ts";

const openTodo = (todo: Todo): void => {
  if (todo.goal && todo.project) app.go({ view: "goal", id: todo.project, goal: todo.id }, "page");
  else editTodo(todo);
};

/** Open parts in plan order, then the done ones. */
function orderParts(parts: Todo[]): Todo[] {
  const plan = (todo: Todo): string => `${todo.date ?? "9999"}${todo.time ?? ""}`;
  return [...parts].sort((a, b) => Number(a.done) - Number(b.done) || plan(a).localeCompare(plan(b)));
}

function plannedHours(parts: Todo[]): string {
  const minutes = parts.filter((part) => !part.done && part.time).reduce((sum, part) => sum + (part.minutes ?? 0), 0);
  return minutes ? `${lengthText(minutes)} planned` : "";
}

// ------------------------------------------------------------- shortcuts --

/** The project whose "Add site" line is open; only ever one, on its own page. */
let addingSite = "";

function shortcutsSection(project: Project): HTMLElement {
  const node = el("section", "group-list");
  const count = project.shortcuts.length;
  node.append(heading("Shortcuts", count > 1 ? `press 1–${count}` : count ? "press 1" : ""));
  const row = el("div", "sites");
  for (const [index, site] of project.shortcuts.entries()) {
    const chip = button("site", "", () => void app.os.shell.openExternal(site.url).catch(() => app.status("Couldn't open that site.")));
    const url = toUrl(site.url);
    const mono = el("span", "site-mono", initialOf(site.name));
    mono.style.background = `oklch(0.55 0.13 ${hueOf(url ? hostOf(url) : site.url)})`;
    chip.append(mono, el("span", "", site.name), el("kbd", "", String(index + 1)));
    chip.title = site.url;
    row.append(chip);
  }
  if (addingSite === project.id) {
    const form = el("div", "site-add");
    const input = el("input");
    input.type = "text";
    input.placeholder = "Address, e.g. tuwel.tuwien.ac.at";
    input.setAttribute("aria-label", "Site address");
    input.spellcheck = false;
    const done = (): void => {
      addingSite = "";
      app.render();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") done();
      if (event.key !== "Enter") return;
      const url = toUrl(input.value);
      if (!url) {
        app.status("That isn't an address that can be opened (https or mailto).");
        return;
      }
      const site = { name: guessName(url), url: url.href };
      app.save(
        app.projects.update((data) => {
          const found = data.projects.find((each) => each.id === project.id);
          if (found && found.shortcuts.length < MAX_SHORTCUTS) found.shortcuts.push(site);
        }),
        "projects",
      );
      done();
    });
    input.addEventListener("blur", () => setTimeout(done, 100));
    form.append(input);
    row.append(form);
    requestAnimationFrame(() => input.focus());
  } else if (project.shortcuts.length < MAX_SHORTCUTS) {
    row.append(
      button("site is-add", withIcon(ICONS.plus, "Add site"), () => {
        addingSite = project.id;
        app.render();
      }),
    );
  }
  node.append(row);
  return node;
}

// ----------------------------------------------------------------- goals --

/** The days a goal's strip covers: a little before today to just past the deadline. */
function stripRange(goal: Todo, parts: Todo[], now: Date): { start: Date; days: number } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dates = parts.map((part) => plannedAt(part)).filter((at): at is Date => at !== null);
  const due = deadlineAt(goal);
  let start = addDays(today, -3);
  for (const at of dates) if (at < start) start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  let end = addDays(today, 10);
  for (const at of [...dates, ...(due ? [due] : [])]) if (at > end) end = addDays(at, 1);
  const days = Math.min(60, Math.max(7, daysBetween(start, end) + 1));
  return { start, days };
}

function goalStrip(goal: Todo, parts: Todo[], project: Project, now: Date): HTMLElement {
  const { start, days } = stripRange(goal, parts, now);
  const strip = el("div", "strip");
  strip.setAttribute("aria-hidden", "true");
  const at = (date: Date): number => (daysBetween(start, date) / days) * 100;
  strip.style.setProperty("--c", hueColor(project.hue));
  for (const part of parts) {
    const plan = plannedAt(part);
    if (!plan) continue;
    const block = el("span", `strip-block${part.done ? " is-done" : ""}`);
    block.style.left = `${at(plan)}%`;
    block.style.width = `calc(${100 / days}% - 2px)`;
    block.title = part.title;
    strip.append(block);
  }
  const today = el("span", "strip-today");
  today.style.left = `${at(now) + 50 / days}%`;
  strip.append(today);
  const due = deadlineAt(goal);
  if (due) {
    const flag = el("span", "strip-flag");
    flag.style.left = `${at(due) + (goal.deadlineTime ? 0 : 100 / days)}%`;
    strip.append(flag);
  }
  return strip;
}

function goalCard(goal: Todo, project: Project, now: Date): HTMLElement {
  const parts = partsOf(goal);
  const done = parts.filter((part) => part.done).length;
  const card = el("article", `goal${goal.done ? " is-done" : ""}`);
  card.dataset.id = goal.id;
  const folded = app.folded.has(goal.id);

  const head = el("div", "goal-head");
  const fold = button("fold", folded ? ICONS.right : ICONS.down, () => {
    if (app.folded.has(goal.id)) app.folded.delete(goal.id);
    else app.folded.add(goal.id);
    app.render();
  });
  fold.setAttribute("aria-label", folded ? "Show parts" : "Hide parts");
  fold.setAttribute("aria-expanded", String(!folded));
  const titles = el("div", "goal-titles");
  const title = button("goal-title", "", () => app.go({ view: "goal", id: project.id, goal: goal.id }, "page"));
  title.textContent = goal.title;
  const meta = [parts.length ? `${done} of ${parts.length} done` : "No parts yet", plannedHours(parts)].filter(Boolean).join(" · ");
  titles.append(title, el("span", "goal-meta", meta));
  const right = el("div", "goal-right");
  if (parts.length) right.append(el("span", "count", `${done}/${parts.length}`));
  const due = dueChip(goal, now);
  if (due) right.append(due);
  head.append(fold, titles, right);
  card.append(head);
  if (folded) return card;

  if (parts.length || deadlineAt(goal)) card.append(goalStrip(goal, parts, project, now));
  const rows = el("div", "goal-rows");
  const shown = orderParts(parts).filter((part) => !part.done || app.showDone);
  for (const part of shown) rows.append(todoRow(part, now, { onOpen: openTodo }));
  if (!goal.done) rows.append(composer({ project: project.id, goal: goal.id, placeholder: "Add a part" }));
  card.append(rows);
  return card;
}

function goalsSection(project: Project, now: Date): HTMLElement {
  const node = el("section", "group-list");
  const goals = goalsOf(project.id);
  const drafting = draftOpenFor(project.id);
  node.append(heading("Goals", drafting ? "" : button("link", withIcon(ICONS.plus, "Goal"), () => openGoalDraft(project.id))));
  if (drafting) node.append(goalDraft(project));
  const open = goals
    .filter((goal) => !goal.done)
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.createdAt - b.createdAt);
  if (!open.length && !drafting) {
    node.append(empty("A goal is a larger piece of work with a deadline, like an assignment. Split it into parts and plan each on a day."));
  }
  for (const goal of open) node.append(goalCard(goal, project, now));
  const done = goals.filter((goal) => goal.done);
  if (done.length && app.showDone) for (const goal of done) node.append(goalCard(goal, project, now));
  return node;
}

// ------------------------------------------------------------- schedule --

function scheduleCard(project: Project, sessions: Session[], now: Date): HTMLElement {
  const card = el("section", "card schedule");
  const cal = app.calendars.calendars.find((each) => each.id === project.link?.calendar);
  card.append(heading("Schedule", cal ? `from ${cal.name}` : "from your calendars"));
  if (!sessions.length) {
    card.append(
      empty(project.code || project.name ? "No sessions found in your calendars." : "Give the course its code to find its sessions."),
      button("link", "Course settings", () => editProject(project)),
    );
    return card;
  }
  const next = nextSession(sessions, now);
  if (next) {
    const row = el("div", "next");
    const when = el("span", "next-day");
    when.append(el("small", "", fmtWeekday(next.start)), el("b", "", String(next.start.getDate())));
    when.style.setProperty("--c", hueColor(project.hue));
    const what = el("div", "next-what");
    const on = next.start <= now;
    what.append(el("b", "", `${on ? "Now" : "Next"}: ${next.title}`));
    const days = daysBetween(now, next.start);
    const rel = on ? "on now" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    what.append(
      el("span", "", [labelOf(app.projects.data, next.type), `${fmtTime(next.start)} – ${fmtTime(next.end)}`, next.location, rel].filter(Boolean).join(" · ")),
    );
    row.append(when, what);
    card.append(row);
  } else {
    card.append(empty(`Ended. The last session was ${fmtDayMonth(sessions.at(-1)!.start)}.`));
  }
  for (const summary of summarize(sessions)) {
    const slot = summary.slots[0];
    const line = el("div", "slot");
    line.append(el("span", "type-key", summary.type || "–"));
    if (slot) {
      line.append(el("span", "", slotLine(slot)));
    } else {
      line.append(el("span", "", `${labelOf(app.projects.data, summary.type)} · ${dayLabel(summary.first, now)} ${fmtTime(summary.first)}`));
    }
    card.append(line);
  }
  return card;
}

// ------------------------------------------------------------------ page --

export function renderProject(page: HTMLElement, project: Project): void {
  const now = new Date();
  const sessions = sessionsFor(project);
  const ended = isEnded(project, now);
  const goals = goalsOf(project.id).filter((goal) => !goal.done);
  const loose = looseOf(project.id);
  const openCount = app.todos.data.todos.filter((todo) => todo.project === project.id && !todo.done && !todo.goal).length;

  const head = el("header", "page-head");
  head.append(backButton(areaById(project.area)?.name ?? "Back", () => app.go(app.route, "list")));
  const titles = el("div", "page-titles");
  const h1 = el("h1");
  const mark = el("span", "title-dot");
  mark.style.background = hueColor(project.hue);
  h1.append(mark, el("span", "", project.name));
  if (project.code) h1.append(el("span", "code", project.code));
  if (ended) h1.append(el("span", "badge", "Ended"));
  titles.append(h1);
  const sub: string[] = [project.kind === "course" ? "Course" : "Project"];
  sub.push(goals.length ? `${goals.length} goal${goals.length === 1 ? "" : "s"}` : "", `${openCount} open todo${openCount === 1 ? "" : "s"}`);
  if (project.kind === "course" && sessions.length) {
    sub.push(`${sessions.length} sessions, until ${fmtDayMonth(sessions.at(-1)!.start)}`);
  }
  titles.append(el("p", "page-sub", sub.filter(Boolean).join(" · ")));
  const actions = el("div", "page-actions");
  actions.append(
    button("button", withIcon(ICONS.gear, "Settings"), () => editProject(project)),
    button("button primary", withIcon(ICONS.plus, "Goal"), () => openGoalDraft(project.id)),
  );
  head.append(titles, actions);

  const left = el("div", "page-main");
  left.append(shortcutsSection(project), goalsSection(project, now));

  const todos = el("section", "group-list");
  const doneCount = app.todos.data.todos.filter((todo) => todo.project === project.id && todo.done).length;
  const toggleDone = doneCount
    ? button("link", app.showDone ? "Hide done" : `Show done (${doneCount})`, () => {
        app.showDone = !app.showDone;
        app.render();
      })
    : "";
  todos.append(heading("Todos", toggleDone));
  const order = (todo: Todo): string => `${Number(todo.done)}${todo.date ?? "9999"}${todo.time ?? ""}${todo.deadline ?? "9999"}`;
  for (const todo of loose.filter((each) => !each.done || app.showDone).sort((a, b) => order(a).localeCompare(order(b)))) {
    todos.append(todoRow(todo, now, { onOpen: openTodo }));
  }
  todos.append(composer({ project: project.id, placeholder: "Add a todo" }));
  left.append(todos, notesSection(project));

  const side = el("aside", "page-side");
  if (project.kind === "course") side.append(scheduleCard(project, sessions, now));
  side.append(calendarPanel({ now, onOpen: openTodo }));

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, body);
}

// ------------------------------------------------------------------ goal --

/** The first day a goal's board shows, per goal. */
const boardStart = new Map<string, Date>();
const BOARD_DAYS = 14;

/** Where to move a part planned after its goal's deadline: the day before, or today. */
function fixDay(goal: Todo, now: Date): string | null {
  const due = deadlineAt(goal);
  if (!due) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const before = addDays(new Date(due.getFullYear(), due.getMonth(), due.getDate()), -1);
  return dateKey(before < today ? today : before);
}

function countdown(goal: Todo, now: Date): HTMLElement {
  const box = el("div", "countdown");
  const at = deadlineAt(goal);
  if (!at) {
    box.append(el("b", "", "No deadline"));
    return box;
  }
  const days = daysBetween(now, at);
  const state = goal.done ? "done" : deadlineState(goal, now) ?? "later";
  box.classList.add(`is-${state}`);
  const big = goal.done ? "Done" : days > 1 ? `${days} days left` : days === 1 ? "Due tomorrow" : days === 0 ? "Due today" : `${-days} day${days === -1 ? "" : "s"} late`;
  box.append(el("b", "", big), el("span", "", `Due ${dueText(goal, now)}`));
  return box;
}

function board(goal: Todo, parts: Todo[], project: Project, now: Date): HTMLElement {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = boardStart.get(goal.id) ?? addDays(today, -3);
  const days = gridDays(start, BOARD_DAYS);
  const end = addDays(start, BOARD_DAYS);
  const due = deadlineAt(goal);
  const events = eventsIn(start, end).filter((occurrence) => !occurrence.allDay);

  const wrap = el("section", "board-wrap");
  const nav = el("div", "board-nav");
  const shift = (by: number): void => {
    boardStart.set(goal.id, addDays(start, by));
    app.render();
  };
  const prev = button("icon-button", ICONS.back, () => shift(-7));
  prev.setAttribute("aria-label", "Earlier");
  const next = button("icon-button", ICONS.next, () => shift(7));
  next.setAttribute("aria-label", "Later");
  nav.append(prev, button("link", "Today", () => {
    boardStart.delete(goal.id);
    app.render();
  }));
  if (due) {
    nav.append(button("link", "Deadline", () => {
      boardStart.set(goal.id, addDays(new Date(due.getFullYear(), due.getMonth(), due.getDate()), -(BOARD_DAYS - 3)));
      app.render();
    }));
  }
  nav.append(el("span", "board-hint", "Drag a part onto a day to plan it. Your calendar's events are shown, so you can see busy days."), next);

  const grid = el("div", "board");
  for (const day of days) {
    const key = dateKey(day);
    const col = el("div", "board-day");
    if (key === dateKey(now)) col.classList.add("is-today");
    if (day.getDay() === 0 || day.getDay() === 6) col.classList.add("is-weekend");
    if (due && dateKey(due) === key) col.classList.add("is-deadline");
    const head = el("div", "board-head");
    head.append(el("small", "", fmtWeekday(day)), el("b", "", String(day.getDate())));
    col.append(head);
    for (const occurrence of events.filter((each) => dateKey(each.start) === key).slice(0, 4)) {
      const owner = ownerOfEvent(occurrence);
      const item = el("span", `board-event${owner ? " is-session" : ""}`);
      if (owner) item.style.setProperty("--c", hueColor(owner.hue));
      const hours = `${occurrence.start.getHours()}–${occurrence.end.getHours()}`;
      item.textContent = `${occurrence.event.summary || "(no title)"} ${hours}`;
      item.title = `${occurrence.event.summary}\n${fmtTime(occurrence.start)} – ${fmtTime(occurrence.end)}`;
      col.append(item);
    }
    for (const part of parts.filter((each) => each.date === key)) col.append(partChip(part, project));
    if (due && dateKey(due) === key) {
      const flag = el("span", "board-flag");
      flag.innerHTML = withIcon(ICONS.flag, goal.deadlineTime ? `Due ${fmtTime(due)}` : "Due");
      col.append(flag);
    }
    dropTarget(col, (id) => {
      planTodo(id, key);
      app.render();
    });
    grid.append(col);
  }
  wrap.append(nav, grid);

  const unplanned = parts.filter((part) => !part.done && !part.date);
  if (unplanned.length) {
    const tray = el("div", "tray");
    tray.append(el("span", "tray-label", "Not planned yet"));
    for (const part of unplanned) tray.append(partChip(part, project));
    wrap.append(tray);
  }
  return wrap;
}

function partChip(part: Todo, project: Project): HTMLElement {
  const chip = button(`part-chip${part.done ? " is-done" : ""}`, "", () => editTodo(part));
  chip.style.setProperty("--c", hueColor(project.hue));
  chip.append(el("b", "", part.title));
  if (part.time) chip.append(el("span", "", [fmtTime(plannedAt(part)!), part.minutes ? lengthText(part.minutes) : ""].filter(Boolean).join(" · ")));
  chip.title = part.title;
  if (!part.done) {
    chip.draggable = true;
    chip.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/x-todo", part.id);
      event.dataTransfer!.effectAllowed = "move";
    });
  }
  return chip;
}

let notesTimer: ReturnType<typeof setTimeout> | undefined;

export function renderGoal(page: HTMLElement, project: Project, goal: Todo): void {
  const now = new Date();
  const parts = partsOf(goal);
  const done = parts.filter((part) => part.done).length;

  const head = el("header", "page-head");
  head.append(backButton(project.code || project.name, () => app.go({ view: "project", id: project.id }, "page"), true));
  const titles = el("div", "page-titles");
  const crumbs = el("p", "crumbs");
  // button() takes markup; names are text, so they go in as textContent.
  const areaCrumb = button("link", "", () => app.go({ view: "area", id: project.area }, "list"));
  areaCrumb.textContent = areaById(project.area)?.name ?? "";
  const projectCrumb = button("link", "", () => app.go({ view: "project", id: project.id }, "page"));
  projectCrumb.textContent = projectLabel(project);
  crumbs.append(areaCrumb, el("span", "", "/"), projectCrumb);
  const h1 = button("h1-button", "", () => editTodo(goal));
  h1.textContent = goal.title;
  h1.title = "Edit goal";
  titles.append(crumbs, h1, el("p", "page-sub", [parts.length ? `${done} of ${parts.length} done` : "No parts yet", plannedHours(parts)].filter(Boolean).join(" · ")));
  head.append(titles, countdown(goal, now));

  const left = el("div", "page-main");
  const list = el("section", "group-list");
  list.append(heading("Parts"));
  const fix = fixDay(goal, now);
  for (const part of orderParts(parts)) {
    const row = todoRow(part, now, { onOpen: openTodo });
    const late = !part.done && (plannedLate(part) || (fix && part.date && goal.deadline && part.date > goal.deadline));
    if (late && fix) {
      row.classList.add("is-late-plan");
      const day = parseDate(fix)!;
      row.append(
        button("link fix", `Move to ${dayLabel(day, now)}`, () => {
          const sameDayAsDue = fix === goal.deadline;
          planTodo(part.id, fix, sameDayAsDue && goal.deadlineTime && part.time && part.time > goal.deadlineTime ? null : undefined);
          app.render();
        }),
      );
    }
    list.append(row);
  }
  if (!goal.done) list.append(composer({ project: project.id, goal: goal.id, placeholder: "Add a part" }));
  left.append(list);

  const side = el("aside", "page-side");
  // Notes read as part of the page, not a form: no box until you're in it,
  // growing with what's written, and saying so only once something changed.
  const notes = el("section", "goal-notes");
  const saved = el("span", "goal-notes-saved");
  notes.append(heading("Notes", saved));
  const area = el("textarea");
  area.value = goal.notes ?? "";
  area.maxLength = MAX_NOTES;
  area.rows = 3;
  area.spellcheck = true;
  area.placeholder = "Add notes: the brief, what the TA said, where the files are…";
  area.setAttribute("aria-label", "Goal notes");
  const grow = (): void => {
    if (CSS.supports("field-sizing", "content")) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 2}px`;
  };
  requestAnimationFrame(grow);
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") area.blur();
  });
  area.addEventListener("input", () => {
    grow();
    saved.textContent = "Editing";
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      const latest = app.todos.data.todos.find((todo) => todo.id === goal.id);
      if (!latest) return;
      const text = area.value.trim();
      const next: Todo = { ...latest };
      if (text) next.notes = text;
      else delete next.notes;
      saveTodo(latest, next);
      saved.textContent = "Saved";
    }, 600);
  });
  notes.append(area);
  side.append(notes);

  const body = el("div", "page-cols");
  body.append(left, side);
  page.replaceChildren(head, board(goal, parts, project, now), body);
}

/** Opens the new-goal card on the project page (the G key). */
export function startGoal(): void {
  openGoalDraft(currentProject()?.id ?? "");
}
