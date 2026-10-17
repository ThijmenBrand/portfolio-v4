// What every part of the Projects app reads: the three stores, where the app
// is, and the derived views of the todo list (a project's goals, a goal's
// parts) that the pages are drawn from.
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Settings } from "../../utils/settings";
import { occurrencesIn, type Occurrence } from "../calendar/query.ts";
import { daysBetween, deadlineAt, type Todo, type TodoStore } from "../todo/store.ts";
import type { CalendarReader } from "./calendars.ts";
import { isSession, sessionsOf, typeOf, type Session } from "./match.ts";
import type { Area, Project, ProjectStore } from "./store.ts";

export type Route =
  | { view: "today" }
  | { view: "upcoming" }
  /** An area's overview, across its courses and projects. */
  | { view: "area"; id: string }
  | { view: "project"; id: string }
  | { view: "goal"; id: string; goal: string }
  | { view: "note"; id: string; file: string };

export type CalendarDays = 1 | 3 | 7;

/** Which of the three columns a phone (or a narrow window) shows. */
export type Pane = "rail" | "list" | "page";

export interface App {
  os: AppInterface;
  todos: TodoStore;
  projects: ProjectStore;
  calendars: CalendarReader;
  settings: Settings;
  route: Route;
  pane: Pane;
  /** How many days the calendar beside a page's todos shows. */
  calendarDays: CalendarDays;
  /** How far from today, in days, the calendar has been stepped. */
  calendarShift: number;
  /** Goals folded shut on a project page, by id. */
  folded: Set<string>;
  /** The project last open in each area, by area id. */
  lastIn: Map<string, string>;
  /** Projects pages show their finished todos too. */
  showDone: boolean;
  /** Ended projects are listed in the area's column. */
  showEnded: boolean;
  /** The area's column is put away, for more room on the page. */
  listHidden: boolean;
  go(route: Route, pane?: Pane): void;
  render(): void;
  /** Fire and forget a store change; a failure shows in the status bar. */
  save(change: Promise<void>, which: "todos" | "projects"): void;
  status(message: string, undo?: () => void): void;
}

/** Filled in by main.ts before anything renders. */
export const app = {} as App;

// ----------------------------------------------------------- the stores --

export const projectById = (id: string | undefined): Project | undefined =>
  id ? app.projects.data.projects.find((project) => project.id === id) : undefined;

export const areaById = (id: string | undefined): Area | undefined =>
  id ? app.projects.data.areas.find((area) => area.id === id) : undefined;

export const todoById = (id: string | undefined): Todo | undefined =>
  id ? app.todos.data.todos.find((todo) => todo.id === id) : undefined;

/** The project a todo is filed under, if that project still exists. */
export const projectOf = (todo: Todo): Project | undefined => projectById(todo.project);

/** The goal a part belongs to, if it is still a goal of the same project. */
export function goalOf(todo: Todo): Todo | undefined {
  const goal = todoById(todo.parent);
  return goal?.goal && goal.project === todo.project ? goal : undefined;
}

export const goalsOf = (projectId: string): Todo[] =>
  app.todos.data.todos.filter((todo) => todo.goal && todo.project === projectId);

export const partsOf = (goal: Todo): Todo[] =>
  app.todos.data.todos.filter((todo) => todo.parent === goal.id && todo.project === goal.project && !todo.goal);

/** A project's todos that are neither a goal nor part of one. */
export const looseOf = (projectId: string): Todo[] =>
  app.todos.data.todos.filter((todo) => todo.project === projectId && !todo.goal && !goalOf(todo));

/** The area a todo is filed straight under (no project), if that area still exists. */
export const areaOfLoose = (todo: Todo): Area | undefined => (todo.project ? undefined : areaById(todo.area));

/** An area's own todos: filed under it, not under one of its projects. */
export const areaTodos = (areaId: string): Todo[] =>
  app.todos.data.todos.filter((todo) => !todo.project && todo.area === areaId);

/** Every todo in an area: its own, and those of its projects. */
export function todosInArea(areaId: string): Todo[] {
  const ids = new Set(app.projects.data.projects.filter((p) => p.area === areaId).map((p) => p.id));
  return app.todos.data.todos.filter((todo) => (todo.project ? ids.has(todo.project) : todo.area === areaId));
}

/** The colour a todo is drawn in: its project's, else its area's. */
export const hueOfTodo = (todo: Todo): number | undefined => (projectOf(todo) ?? areaOfLoose(todo))?.hue;

/** The area the current page belongs to, if it belongs to one. */
export function currentArea(): string | undefined {
  const route = app.route;
  if (route.view === "area") return route.id;
  if (route.view === "project" || route.view === "goal" || route.view === "note") {
    return projectById(route.id)?.area;
  }
  return undefined;
}

export const currentProject = (): Project | undefined =>
  app.route.view === "project" || app.route.view === "goal" || app.route.view === "note"
    ? projectById(app.route.id)
    : undefined;

// ------------------------------------------------------------- sessions --

const SESSION_PAST_MS = 200 * 86_400_000;
const SESSION_AHEAD_MS = 400 * 86_400_000;

const sessionCache = new Map<string, Session[]>();

/** A linked course's sessions, a long way back and forward. Cached per calendar read. */
export function sessionsFor(project: Project): Session[] {
  const link = project.link;
  if (project.kind !== "course" || !link || (!project.code && !project.name)) return [];
  const day = new Date().toDateString();
  const key = [project.id, project.code, project.name, link.calendar, link.skip.join(","), app.calendars.revision, day].join("|");
  const known = sessionCache.get(key);
  if (known) return known;
  const now = Date.now();
  const events = app.calendars.calendars
    .filter((cal) => !link.calendar || cal.id === link.calendar)
    .flatMap((cal) => cal.events);
  const sessions = sessionsOf(events, project.code, project.name, new Date(now - SESSION_PAST_MS), new Date(now + SESSION_AHEAD_MS), link.skip);
  for (const old of sessionCache.keys()) if (old.startsWith(`${project.id}|`)) sessionCache.delete(old);
  sessionCache.set(key, sessions);
  return sessions;
}

/** Ended by hand, or a linked course whose last session is over. */
export function isEnded(project: Project, now = new Date()): boolean {
  if (project.ended !== undefined) return project.ended;
  if (project.kind !== "course" || !project.link?.end) return false;
  const sessions = sessionsFor(project);
  return sessions.length > 0 && sessions.at(-1)!.end < now;
}

/** The linked course an event is a session of, if any. */
export function courseOfEvent(occurrence: Occurrence): Project | undefined {
  for (const project of app.projects.data.projects) {
    const link = project.link;
    if (project.kind !== "course" || !link || (!project.code && !project.name)) continue;
    if (link.calendar && link.calendar !== occurrence.sourceId) continue;
    if (!isSession(occurrence.event, project.code, project.name)) continue;
    if (link.skip.includes(typeOf(occurrence.event.summary, project.code))) continue;
    return project;
  }
  return undefined;
}

/** The area whose own calendar an event is from, if any. */
export const areaOfEvent = (occurrence: Occurrence): Area | undefined =>
  app.projects.data.areas.find((area) => area.calendar && area.calendar === occurrence.sourceId);

/** The colour an event is drawn in, if it's anyone's: its course's, else its area's. */
export function ownerOfEvent(occurrence: Occurrence): { hue: number; course?: Project } | undefined {
  const course = courseOfEvent(occurrence);
  if (course) return { hue: course.hue, course };
  const area = areaOfEvent(occurrence);
  return area && { hue: area.hue };
}

/** An area's own calendar's timed events overlapping [from, to), in order. */
export function areaEventsIn(area: Area, from: Date, to: Date): Occurrence[] {
  if (!area.calendar) return [];
  const cal = app.calendars.calendars.find((each) => each.id === area.calendar);
  if (!cal) return [];
  return occurrencesIn([{ id: cal.id, name: cal.name, hue: cal.hue, events: cal.events }], from, to)
    .filter((occurrence) => !occurrence.allDay)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Every calendar event overlapping [from, to), across the visible calendars. */
export function eventsIn(from: Date, to: Date): Occurrence[] {
  return occurrencesIn(
    app.calendars.calendars.map((cal) => ({ id: cal.id, name: cal.name, hue: cal.hue, events: cal.events })),
    from,
    to,
  );
}

// ---------------------------------------------------------------- dates --

/** Days left until a todo's deadline, negative once past; null with none. */
export function daysLeft(todo: Todo, now: Date): number | null {
  const at = deadlineAt(todo);
  return at ? daysBetween(now, at) : null;
}
