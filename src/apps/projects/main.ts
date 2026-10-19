// Projects — areas (Uni, Work, Private), the courses and projects in them,
// and everything for each one on its own page: shortcuts, goals split into
// parts planned before their deadline, todos and notes.
//
// Three columns: the areas (and Today and Upcoming, which cut across them),
// the area's overview and its courses and projects, and the page. Inside an
// area the first shrinks to a strip of icons, and the second can be put away
// too. On a phone, or in a narrow window, they become a drill-down, one at a
// time.
//
// The todos are the Todo app's (../todo/store.ts), filed by project, so the
// Todo app and the Calendar show them too. Areas and projects are kept by
// store.ts; the calendars are only read (calendars.ts), for a course's
// sessions and for the busy time around which things get planned. Like the
// Todo app, nothing here may branch on who is running it.
import type { AppInterface } from "../../kernel/syscalls/api";
import { applyAccent, ensureConfigDir, loadSettings } from "../../utils/settings";
import { ruleSpaceAt } from "../shortcuts/schedule";
import { dateKey, deadlineState, isForToday, openTodos, type Todo } from "../todo/store.ts";
import { listLine, renderArea } from "./area.ts";
import { openCalendars } from "./calendars.ts";
import { canDeleteArea, deleteArea, deleteProject, editArea, editProject } from "./dialogs.ts";
import { sessionNow } from "./match.ts";
import { openMenu } from "./menu.ts";
import { leaveNote, notesChanged, renderNote } from "./notes.ts";
import { renderGoal, renderProject, startGoal } from "./project.ts";
import { openSite } from "./sites.ts";
import {
  app,
  areaById,
  areaEventsIn,
  currentArea,
  currentProject,
  isEnded,
  projectById,
  sessionsFor,
  todoById,
  todosInArea,
  type Pane,
  type Route,
} from "./state.ts";
import { fromShortcuts, MAX_AREAS, openProjects, saveProblem, type Project } from "./store.ts";
import { renderToday, renderUpcoming } from "./today.ts";
import { isPhone, PHONE_QUERY } from "../../utils/phone.ts";
import { areaMark, button, buildFormats, dot, el, ICONS, withIcon } from "./ui.ts";
import projectsHTML from "./projects.html?raw";
import "../../ui/theme.css";
import "../../utils/confirm.css";
import "./projects.css";

const TICK_MS = 60_000;
const STATUS_MS = 6000;

const field = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-field="${name}"]`)!;
const action = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-action="${name}"]`)!;

/** Something changed while you were typing; draw it once you stop. */
let stale = false;
/** The page drawn last, so a new one starts scrolled to the top. */
let drawnRoute = "";
/** What the schedule wanted last; the app follows it again only when it changes. */
let lastAuto = "";
/** The Shortcuts app's file, while its spaces haven't been offered yet. */
let shortcutsBody: string | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let undoAction: (() => void) | null = null;

// ---------------------------------------------------------------- render --

/** Typing, or a sheet is open: a re-render now would throw away what's typed. */
function busy(): boolean {
  if (document.querySelector("dialog[open]")) return true;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  // The new-goal card keeps what's typed itself, but a redraw would still
  // pull focus out from under its buttons and calendar.
  return active.matches("input:not([type=checkbox]), textarea, select") || active.closest(".goal-draft") !== null;
}

function render(): void {
  stale = false;
  const root = field("app");
  root.dataset.pane = app.pane;
  const area = currentArea();
  // Inside an area its own column says where you are, so the areas need
  // only their icons. A phone shows one column at a time and keeps both.
  const compact = area !== undefined && !isPhone();
  root.classList.toggle("has-list", area !== undefined && !(compact && app.listHidden));
  root.classList.toggle("is-compact", compact);
  renderRail(compact);
  renderList(area);
  renderPage();
  renderKeys();
}

/** A redraw for something that happened elsewhere: waits while you type. */
function renderSoon(): void {
  if (busy()) stale = true;
  else render();
}

function go(route: Route, pane?: Pane): void {
  if (app.route.view === "note" && JSON.stringify(route) !== JSON.stringify(app.route)) void leaveNote();
  app.route = route;
  app.pane = pane ?? "page";
  if (route.view === "area") app.lastIn.delete(route.id);
  if (route.view === "project" || route.view === "goal" || route.view === "note") {
    const project = projectById(route.id);
    if (project) app.lastIn.set(project.area, project.id);
  }
  render();
}

/** An area's page: the project last open in it, else its overview. */
function areaRoute(areaId: string): Route {
  const last = projectById(app.lastIn.get(areaId));
  if (last && last.area === areaId && !isEnded(last)) return { view: "project", id: last.id };
  return { view: "area", id: areaId };
}

// ------------------------------------------------------------------ rail --

/** How many of these need doing today, and whether any is overdue. */
function attention(todos: readonly Todo[], now: Date): { count: number; late: boolean } {
  const today = dateKey(now);
  let count = 0;
  let late = false;
  for (const todo of todos) {
    if (todo.done || todo.goal) continue;
    const isLate = deadlineState(todo, now) === "late";
    if (isLate) late = true;
    if (isLate || isForToday(todo, today)) count++;
  }
  return { count, late };
}

function toggleList(): void {
  app.listHidden = !app.listHidden;
  render();
}

function renderRail(compact: boolean): void {
  const rail = field("rail");
  const now = new Date();
  const route = app.route;
  rail.replaceChildren();

  const item = (label: string, icon: Node, on: boolean, onClick: () => void, count?: { count: number; late: boolean }): HTMLButtonElement => {
    const node = button(`rail-item${on ? " is-on" : ""}`, "", onClick);
    node.append(icon, el("span", "rail-label", label));
    if (count?.count) node.append(el("span", `rail-count${count.late ? " is-late" : ""}`, String(count.count)));
    if (on) node.setAttribute("aria-current", "page");
    // Icons only: the name is said on hover and to a screen reader.
    if (compact) {
      node.title = count?.count ? `${label} · ${count.count}` : label;
      node.setAttribute("aria-label", node.title);
    }
    return node;
  };
  const icon = (svg: string): HTMLSpanElement => {
    const node = el("span", "rail-icon");
    node.innerHTML = svg;
    return node;
  };

  if (compact) {
    const toggle = button("icon-button rail-toggle", ICONS.sidebar, toggleList);
    const label = app.listHidden ? "Show courses and projects" : "Hide courses and projects";
    toggle.title = `${label} (\\)`;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-pressed", String(!app.listHidden));
    rail.append(toggle);
  }
  rail.append(
    item("Today", icon(ICONS.today), route.view === "today", () => go({ view: "today" }), attention(app.todos.data.todos, now)),
    item("Upcoming", icon(ICONS.upcoming), route.view === "upcoming", () => go({ view: "upcoming" })),
  );
  rail.append(el("h2", "rail-head", "Areas"));
  const area = currentArea();
  for (const each of app.projects.data.areas) {
    const swatch = areaMark(each);
    // The area you're in, picked again, brings its column back.
    const open = (): void => {
      if (area === each.id && app.listHidden) toggleList();
      else go(areaRoute(each.id), "list");
    };
    const node = item(each.name, swatch, area === each.id, open, attention(todosInArea(each.id), now));
    node.addEventListener("contextmenu", (event) =>
      openMenu(event, node, [
        { label: "Area settings…", action: () => editArea(each) },
        null,
        { label: "Delete area…", danger: true, disabled: !canDeleteArea(), action: () => void deleteArea(each) },
      ]),
    );
    rail.append(node);
  }
  // An empty tile after the areas, where the next one would go.
  const add = item("New area", icon(ICONS.plus), false, () => editArea());
  add.classList.add("rail-add");
  rail.append(add);
  const storage = el("p", "storage");
  storage.textContent =
    app.projects.backing === "cloud" ? "Kept in cloud storage, the same in every browser." : "Kept in this browser.";
  rail.append(el("span", "spacer"), storage);
}

// ------------------------------------------------------------------ list --

function renderList(areaId: string | undefined): void {
  const list = field("list");
  list.replaceChildren();
  const area = areaById(areaId);
  if (!area) return;
  const now = new Date();
  const current = currentProject()?.id;

  const head = el("header", "list-head");
  const back = button("back-button", withIcon(ICONS.back, "Projects"), () => go(app.route, "rail"));
  const swatch = areaMark(area);
  const settings = button("icon-button", ICONS.gear, () => editArea(area));
  settings.setAttribute("aria-label", `${area.name} settings`);
  settings.title = "Area settings";
  head.append(back, swatch, el("h2", "", area.name), settings);
  list.append(head);

  const onOverview = app.route.view === "area";
  const overview = button(`list-item is-overview${onOverview ? " is-on" : ""}`, "", () => go({ view: "area", id: area.id }));
  const label = el("span", "list-name");
  const icon = el("span", "list-icon");
  icon.innerHTML = ICONS.overview;
  label.append(icon, el("span", "", "Overview"));
  const { count, late } = attention(todosInArea(area.id), now);
  if (count) label.append(el("span", `rail-count${late ? " is-late" : ""}`, String(count)));
  overview.append(label);
  if (onOverview) overview.setAttribute("aria-current", "page");
  list.append(overview);

  const projects = app.projects.data.projects.filter((project) => project.area === area.id);
  const open = projects.filter((project) => !isEnded(project, now));
  const ended = projects.filter((project) => isEnded(project, now));
  const group = (title: string, items: Project[]): void => {
    if (!items.length) return;
    list.append(el("h3", "list-group", title));
    for (const project of items) {
      const node = button(`list-item${project.id === current ? " is-on" : ""}${isEnded(project, now) ? " is-ended" : ""}`, "", () =>
        go({ view: "project", id: project.id }),
      );
      const name = el("span", "list-name");
      name.append(dot(project.hue), el("span", "", project.code ? `${project.code} · ${project.name}` : project.name));
      node.append(name, listLine(project, now));
      if (project.id === current) node.setAttribute("aria-current", "page");
      const kind = project.kind === "course" ? "course" : "project";
      node.addEventListener("contextmenu", (event) =>
        openMenu(event, node, [
          { label: "Open", action: () => go({ view: "project", id: project.id }) },
          { label: `${kind === "course" ? "Course" : "Project"} settings…`, action: () => editProject(project) },
          null,
          { label: `Delete ${kind}…`, danger: true, action: () => void deleteProject(project) },
        ]),
      );
      list.append(node);
    }
  };
  group("Courses", open.filter((project) => project.kind === "course"));
  group("Projects", open.filter((project) => project.kind === "project"));
  if (!open.length) list.append(el("p", "list-empty", "No courses or projects. Todos can go straight on the Overview."));
  if (ended.length) {
    const toggle = button("list-group is-toggle", withIcon(app.showEnded ? ICONS.down : ICONS.right, `Ended · ${ended.length}`), () => {
      app.showEnded = !app.showEnded;
      render();
    });
    list.append(toggle);
    if (app.showEnded) group("", ended);
  }
  list.append(el("span", "spacer"), button("list-add", withIcon(ICONS.plus, "New course or project"), () => editProject(undefined, area.id)));
}

// ------------------------------------------------------------------ page --

function renderPage(): void {
  const page = field("page");
  const route = app.route;
  const key = JSON.stringify(route);
  const scroll = page.scrollTop;

  switch (route.view) {
    case "today":
      renderToday(page);
      if (shortcutsBody !== null && !app.projects.data.shortcutsOffered) page.prepend(shortcutsOffer());
      break;
    case "upcoming":
      renderUpcoming(page);
      break;
    case "area": {
      const area = areaById(route.id);
      if (!area) return go({ view: "today" });
      renderArea(page, area);
      break;
    }
    case "project": {
      const project = projectById(route.id);
      if (!project) return go({ view: "today" });
      renderProject(page, project);
      break;
    }
    case "goal": {
      const project = projectById(route.id);
      const goal = todoById(route.goal);
      if (!project) return go({ view: "today" });
      if (!goal || !goal.goal) return go({ view: "project", id: project.id });
      renderGoal(page, project, goal);
      break;
    }
    case "note": {
      const project = projectById(route.id);
      if (!project) return go({ view: "today" });
      renderNote(page, project, route.file);
      break;
    }
  }
  // A new page starts at the top; the same page drawn again stays put.
  page.scrollTop = key === drawnRoute ? scroll : 0;
  drawnRoute = key;
}

function shortcutsOffer(): HTMLElement {
  const box = el("section", "offer");
  let spaces = 0;
  let sites = 0;
  try {
    const raw = JSON.parse(shortcutsBody!) as { spaces?: { shortcuts?: unknown[] }[] };
    spaces = raw.spaces?.length ?? 0;
    sites = raw.spaces?.reduce((sum, space) => sum + (space.shortcuts?.length ?? 0), 0) ?? 0;
  } catch {
    /* counted as nothing */
  }
  box.append(
    el("b", "", "Bring in your Shortcuts?"),
    el("span", "", `Its ${spaces} space${spaces === 1 ? "" : "s"} and ${sites} site${sites === 1 ? "" : "s"} become areas and projects here, with their times. The Shortcuts app keeps its own copy.`),
  );
  const done = (): void => {
    app.save(app.projects.update((data) => void (data.shortcutsOffered = true)), "projects");
  };
  box.append(
    button("button primary", "Bring them in", () => {
      const taken = new Set(app.projects.data.projects.map((project) => project.folder.toLowerCase()));
      const { areas, projects } = fromShortcuts(shortcutsBody!, taken);
      let brought = 0;
      app.save(
        app.projects.update((data) => {
          // Where each space's projects go, decided against this copy: an area
          // of the same name (one already here, or an earlier space's) joins
          // it; otherwise a new area, while there's room for one. A project
          // with nowhere to go is left out, not filed under a missing area.
          const into = new Map<string, string>();
          for (const area of areas) {
            const same = data.areas.find((each) => each.name.toLowerCase() === area.name.toLowerCase());
            if (same) {
              if (!same.rules.length) same.rules = structuredClone(area.rules);
              into.set(area.id, same.id);
            } else if (data.areas.length < MAX_AREAS) {
              data.areas.push(structuredClone(area));
              into.set(area.id, area.id);
            }
          }
          brought = 0;
          for (const project of projects) {
            const area = into.get(project.area);
            if (!area) continue;
            brought++;
            if (!data.projects.some((each) => each.id === project.id)) {
              data.projects.push({ ...structuredClone(project), area });
            }
          }
          data.shortcutsOffered = true;
        }),
        "projects",
      );
      // update() runs the change on screen at once, so `brought` is this copy's count.
      app.status(`Brought in ${brought} project${brought === 1 ? "" : "s"} from Shortcuts.`);
      render();
    }),
    button("button", "No thanks", () => {
      done();
      render();
    }),
  );
  return box;
}

function renderKeys(): void {
  const keys = field("keys");
  const hint = (label: string, ...caps: string[]): HTMLSpanElement => {
    const span = el("span");
    for (const cap of caps) span.append(el("kbd", "", cap));
    span.append(` ${label}`);
    return span;
  };
  const view = app.route.view;
  const list = [hint("todo", "N"), hint("today", "T"), hint("upcoming", "U")];
  if (currentArea() !== undefined && !isPhone()) list.push(hint(app.listHidden ? "show list" : "hide list", "\\"));
  if (view === "project") list.unshift(hint("open site", "1", "9"), hint("goal", "G"));
  if (view === "area") list.unshift(hint("open site", "1", "9"));
  if (view === "goal" || view === "note") list.unshift(hint("back", "Esc"));
  const area = currentArea();
  if (area && app.projects.data.projects.some((each) => each.area === area)) list.push(hint("project", "[", "]"));
  keys.replaceChildren(...list);
}

// ---------------------------------------------------------------- status --

function status(message: string, undo?: () => void): void {
  field("status-text").textContent = message;
  const undoButton = action("undo");
  undoAction = undo ?? null;
  undoButton.hidden = !undo;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    field("status-text").textContent = "";
    undoButton.hidden = true;
    undoAction = null;
  }, STATUS_MS);
}

function save(change: Promise<void>, which: "todos" | "projects"): void {
  change.catch((error: unknown) => {
    console.error("[projects]", error);
    status(saveProblem(error, which === "todos" ? app.todos.backing : app.projects.backing));
    render();
  });
}

// ------------------------------------------------------------------ keys --

function onKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (busy()) return;
  const project = currentProject();
  const view = app.route.view;
  // An area's sites on its overview, a project's on its page.
  const owner = view === "project" ? project : view === "area" ? areaById(currentArea()) : undefined;
  if (/^[1-9]$/.test(event.key) && owner) {
    const site = owner.shortcuts[Number(event.key) - 1];
    if (site) {
      event.preventDefault();
      openSite(site.url);
    }
    return;
  }
  switch (event.key) {
    case "n":
    case "N":
      event.preventDefault();
      document.querySelector<HTMLInputElement>("[data-composer]:not([data-composer-goal])")?.focus();
      break;
    case "g":
    case "G":
      if (view === "project") {
        event.preventDefault();
        startGoal();
      }
      break;
    case "t":
    case "T":
      go({ view: "today" });
      break;
    case "u":
    case "U":
      go({ view: "upcoming" });
      break;
    case "\\":
      if (currentArea() !== undefined && !isPhone()) {
        event.preventDefault();
        toggleList();
      }
      break;
    case "Escape":
      if ((view === "goal" || view === "note") && project) go({ view: "project", id: project.id });
      break;
    case "[":
    case "]": {
      const area = currentArea();
      if (!area) break;
      const list = app.projects.data.projects.filter((each) => each.area === area && (!isEnded(each) || each.id === project?.id));
      if (!list.length) break;
      const at = list.findIndex((each) => each.id === project?.id);
      const next = list[(at + (event.key === "]" ? 1 : list.length - 1) + (at === -1 && event.key === "[" ? 1 : 0)) % list.length]!;
      go({ view: "project", id: next.id });
      break;
    }
    default:
  }
}

// ------------------------------------------------------------- schedule --

/**
 * Where the schedule says to be now: a course whose session is on (and asks
 * for it), else an area with an event on in its own calendar (and asking),
 * else an area whose times say so, else Today.
 */
function autoTarget(now: Date): { key: string; route: Route } {
  for (const project of app.projects.data.projects) {
    if (project.kind !== "course" || !project.link?.open || isEnded(project, now)) continue;
    const session = sessionNow(sessionsFor(project), now);
    if (session) return { key: `course:${project.id}:${session.key}`, route: { view: "project", id: project.id } };
  }
  for (const area of app.projects.data.areas) {
    if (!area.openDuring) continue;
    // An event marked free (a reminder, say) is no reason to switch.
    const on = areaEventsIn(area, now, new Date(now.getTime() + 1)).find((each) => !each.event.transparent);
    if (on) return { key: `event:${area.id}:${on.event.uid}:${on.start.getTime()}`, route: areaRoute(area.id) };
  }
  const area = ruleSpaceAt(app.projects.data.areas, now.getDay(), now.getHours() * 60 + now.getMinutes());
  if (area) return { key: `area:${area}`, route: areaRoute(area) };
  return { key: "today", route: { view: "today" } };
}

/** Follows the schedule when what it wants changes; a page you picked stays until then. */
function followSchedule(): void {
  const target = autoTarget(new Date());
  if (target.key === lastAuto) return;
  if (busy()) return;
  lastAuto = target.key;
  go(target.route);
}

// ------------------------------------------------------------------ sync --

async function pullTodos(): Promise<void> {
  if (await app.todos.reload().catch(() => false)) renderSoon();
}

async function pullProjects(): Promise<void> {
  if (await app.projects.reload().catch(() => false)) renderSoon();
}

async function pullCalendars(): Promise<void> {
  if (await app.calendars.refresh().catch(() => false)) renderSoon();
}

// ------------------------------------------------------------------ main --

export async function main(appOs: AppInterface): Promise<void> {
  const os = appOs;
  const settings = await loadSettings(os);
  applyAccent(settings);

  const handle = await os.windows.create({ title: "Projects" });
  void handle.onCloseRequest(() => void leaveNote().finally(() => void os.process.exit(0)));
  document.body.innerHTML = projectsHTML;

  const [todos, projects, calendars] = await Promise.all([openTodos(os), openProjects(os), openCalendars(os)]);
  Object.assign(app, {
    os,
    todos,
    projects,
    calendars,
    settings,
    route: { view: "today" },
    pane: "page",
    calendarDays: 3,
    calendarShift: 0,
    folded: new Set<string>(),
    lastIn: new Map<string, string>(),
    showDone: false,
    showEnded: false,
    listHidden: false,
    go,
    render,
    save,
    status,
  });
  buildFormats();

  if (!projects.data.shortcutsOffered) {
    const body = await os.fs.readTextFile(`${await ensureConfigDir(os)}/shortcuts.json`).catch(() => null);
    if (body && /"url"\s*:/.test(body)) shortcutsBody = body;
  }

  await os.process.onSignal("SIGHUP", () => {
    void loadSettings(os).then((next) => {
      app.settings = next;
      applyAccent(next);
      buildFormats();
      renderSoon();
    });
  });

  action("undo").addEventListener("click", () => {
    const undo = undoAction;
    undoAction = null;
    action("undo").hidden = true;
    field("status-text").textContent = "";
    undo?.();
  });
  document.addEventListener("keydown", onKey);
  // Into or out of phone width: the columns change between a row and a drill-down.
  matchMedia(PHONE_QUERY).addEventListener("change", () => renderSoon());
  // Typing ended: draw what changed meanwhile.
  document.addEventListener("focusout", () => setTimeout(() => stale && !busy() && render()));
  document.addEventListener("close", () => setTimeout(() => stale && !busy() && render()), true);

  const target = autoTarget(new Date());
  lastAuto = target.key;
  go(target.route);

  await os.events.subscribe(["fs.changed"], (event) => {
    if (event.path === app.todos.path) void pullTodos();
    else if (event.path === app.projects.path) void pullProjects();
    else if (app.calendars.watches(event.path)) void pullCalendars();
    else notesChanged(event.path);
  });
  // Another browser's edits raise no event here, the day rolls over, and
  // sessions start: all picked up on the minute.
  await os.timers.setInterval(() => {
    void Promise.all([pullTodos(), pullProjects(), pullCalendars()]).then(() => {
      followSchedule();
      renderSoon();
    });
  }, TICK_MS);
}
