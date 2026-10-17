// Calendar — your own calendars, and the ones you subscribe to.
//
// Your own calendars (mine.ts) are the ones you can write in: make events,
// edit and delete them. They live in cloud storage where that mount will have
// us and in ~/.config otherwise, decided by trying the mount.
//
// Subscriptions stay read-only. Two kinds: an https .ics link, fetched
// through os.net.fetch, and an .ics file imported from the VFS. The syscall
// is admin-only, so for most people a link simply fails; sync.ts makes sure
// that failure is worded exactly like any other network failure, and
// importing a file works for everyone. A subscribed event can be copied into
// a calendar of your own, and edited there. Nothing in this file may branch
// on who is running it.
//
// The Todo app's dated todos are drawn here too, from the same file the Todo
// app keeps, and can be ticked off from any view: each at the time it is
// planned for, and each open one's deadline as a flag on the day it is due.
import type { AppInterface } from "../../kernel/syscalls/api";
import { isPhone, PHONE_QUERY } from "../../utils/phone";
import { applyAccent, loadSettings, type Settings } from "../../utils/settings";
import { hueOf } from "../../utils/hue";
import type { CalEvent } from "./parse.ts";
import { parseIcs } from "./parse.ts";
import { pling } from "../todo/pling.ts";
import {
  dateKey,
  daysBetween,
  deadlineAt,
  deadlineState,
  isForToday,
  isTime,
  openTodos,
  parseDate,
  plannedAt,
  plannedLate,
  saveProblem,
  type Todo,
  type TodoStore,
} from "../todo/store.ts";
import {
  buildEvent,
  cleanUrl,
  deviceZone,
  FREQS,
  MAX_INTERVAL,
  repeatOf,
  wallOf,
  type Draft,
} from "./draft.ts";
import { wireGrid } from "./gestures.ts";
import {
  DEFAULT_NAME,
  MAX_CALENDARS,
  MAX_NAME,
  mineProblem,
  openMine,
  type MineStore,
  type OwnCalendar,
} from "./mine.ts";
import type { Freq } from "./rrule.ts";
import {
  compareOccurrences,
  occKey,
  occurrencesIn,
  type Occurrence,
  type QuerySource,
} from "./query.ts";
import {
  guessFeedName,
  hueFor,
  MAX_SOURCES,
  newId,
  openStore,
  toIcsUrl,
  VIEWS,
  type Source,
  type Store,
  type View,
} from "./store.ts";
import { due, IMPORT_HINT, syncMany, syncOne, type SyncDeps } from "./sync.ts";
import { todoOccurrences } from "./todos.ts";
import { projectFiles, readProjectHues } from "../projects/store.ts";
import {
  addDays,
  AGENDA_DAYS,
  midnight,
  placeNowLine,
  renderAgenda,
  renderMonth,
  renderWeek,
  sameDay,
  startOfWeek,
  type ViewContext,
} from "./views.ts";
import { addDays as addNaiveDays, fields, naive, startOfDay, type Naive } from "./zone.ts";
import calendarHTML from "./calendar.html?raw";
import "../../ui/theme.css";
import "./calendar.css";

const TICK_MS = 60_000;
const HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
/**
 * Narrower than this and the calendar list stops being a column of its own
 * and becomes a sheet over the view. The one place this is decided: the
 * stylesheet follows the .is-sheet class rather than repeating the query,
 * because a second copy drifting out of step is what left the list docked and
 * floating over the toolbar at the same time.
 */
const SHEET_QUERY = "(max-width: 760px)";
/** Breathing room between the popover and the window's edges, and its anchor. */
const EDGE = 8;
const GAP = 4;
/** Expansion slack each side, so stepping a period is a filter, not a re-expand. */
const PAD: Record<View, number> = { month: 31, week: 7, day: 7, agenda: 0 };

let os: AppInterface;
let store: Store;
let mine: MineStore;
/** mine.calendars as last expanded; it is replaced on every change. */
let mineSeen: readonly OwnCalendar[] = [];
let mineRev = 0;
let todos: TodoStore;
/** Bumped whenever the todo list changes, which invalidates the expansion. */
let todoRev = 0;
/** Each Projects project's colour, by id: what its todos are drawn in. */
let projectHues = new Map<string, number>();
let projectFileList: string[] = [];
/** The todo ticked off a moment ago, drawn with a flourish on the next render. */
let ticked = "";
/**
 * When the views were last drawn: a missed plan moves at midnight, and a
 * timed deadline turns red the moment it passes.
 */
let drawnAt = 0;
let settings: Settings;
let anchor = midnight(new Date());
let focused = midnight(new Date());
let agendaSpan = AGENDA_DAYS;

/** sourceId -> its parsed events, and a counter that invalidates the cache. */
const parsed = new Map<string, CalEvent[]>();
const revisions = new Map<string, number>();

let timeFmt: Intl.DateTimeFormat;
let weekdayFmt: Intl.DateTimeFormat;
let longWeekdayFmt: Intl.DateTimeFormat;
let dayMonthFmt: Intl.DateTimeFormat;
let monthFmt: Intl.DateTimeFormat;
let fullFmt: Intl.DateTimeFormat;
let rangeFmt: Intl.DateTimeFormat;

const field = (name: string) => document.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
const action = (name: string) => document.querySelector<HTMLElement>(`[data-action="${name}"]`)!;
const template = (id: string) => document.querySelector<HTMLTemplateElement>(`#${id}`)!;

// ------------------------------------------------------------ formatting --

function buildFormats(): void {
  const hour12 = !settings.clock24h;
  timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12 });
  weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  longWeekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  dayMonthFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  fullFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  rangeFmt = new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

const time = (at: Date) => timeFmt.format(at);

/**
 * "Oct 12 – 18, 2026", and "Dec 28, 2026 – Jan 3, 2027" across a boundary.
 * formatRange decides how much to repeat, and in what order, per locale.
 */
function weekTitle(start: Date, days: number): string {
  return rangeFmt.formatRange(start, addDays(start, days - 1));
}

// ----------------------------------------------------------------- state --

const view = (): View => store.data.view;
const weekDays = (): number => (isPhone() ? 3 : 7);

/** The columns the hour grid draws: a week (3 days on a phone), or one day. */
function gridRange(): { start: Date; days: number } {
  if (view() === "day") return { start: anchor, days: 1 };
  const days = weekDays();
  // On a phone the anchor day leads; a 7-column week starts on Monday.
  return { start: days === 7 ? startOfWeek(anchor) : anchor, days };
}

const calendarHue = (calendar: OwnCalendar): number => calendar.hue ?? hueOf(calendar.id);

function enabledSources(): QuerySource[] {
  const own = mine.calendars
    .filter((calendar) => !calendar.hidden)
    .map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      hue: calendarHue(calendar),
      events: calendar.events,
      mine: true,
    }));
  const subscribed = store.data.sources
    .filter((source) => source.enabled)
    .map((source) => ({
      id: source.id,
      name: source.name,
      hue: hueFor(source),
      events: parsed.get(source.id) ?? [],
    }));
  return [...own, ...subscribed];
}

let cacheKey = "";
const windows = new Map<string, Occurrence[]>();

function revKey(): string {
  if (mine.calendars !== mineSeen) {
    mineSeen = mine.calendars;
    mineRev++;
  }
  return `mine:${mineRev}|${store.data.sources
    .map((s) => `${s.id}:${s.enabled ? 1 : 0}:${revisions.get(s.id) ?? 0}`)
    .join(",")}|todos:${
    // The day is in the key because the todos drawn depend on it: a plan
    // missed yesterday is carried over to today.
    store.data.todos ? `${todoRev}:${store.data.deadlines ? 1 : 0}:${dateKey(new Date())}` : "off"
  }`;
}

/**
 * Expansion is the expensive part, so it runs for a padded range and every
 * repaint inside that range is a filter. Stepping to the next month is then
 * free, which is what makes the arrows feel instant.
 */
function occurrences(from: Date, to: Date): Occurrence[] {
  const key = revKey();
  if (key !== cacheKey) {
    windows.clear();
    cacheKey = key;
  }
  const pad = PAD[view()];
  const lo = addDays(from, -pad);
  const hi = addDays(to, pad);
  const windowKey = `${lo.getTime()}:${hi.getTime()}`;
  let items = windows.get(windowKey);
  if (!items) {
    items = occurrencesIn(enabledSources(), lo, hi);
    if (store.data.todos) {
      const own = todoOccurrences(todos.data.todos, lo, hi, "Todos", new Date(), (todo) =>
        projectHues.get(todo.project ?? todo.area ?? ""),
      ).filter(
        (o) => store.data.deadlines || o.todoPart !== "deadline",
      );
      items = [...items, ...own].sort(compareOccurrences);
    }
    if (windows.size >= 4) windows.delete(windows.keys().next().value!);
    windows.set(windowKey, items);
  }
  return items.filter((o) => o.start < to && o.end > from);
}

function openDay(day: Date): void {
  anchor = midnight(day);
  focused = anchor;
  setView("day");
}

function context(): ViewContext {
  return {
    occurrences,
    time,
    weekday: (at, long) => (long ? longWeekdayFmt : weekdayFmt).format(at),
    dayMonth: (at) => dayMonthFmt.format(at),
    today: midnight(new Date()),
    now: new Date(),
    focused,
    openDetail,
    toggleTodo,
    ticked,
    openDay,
    focusDay: (day) => {
      focused = midnight(day);
      render();
    },
    newEvent: (start, end, allDay) => openEventEditor({ start, end, allDay }),
  };
}

// ---------------------------------------------------------------- render --

function render(): void {
  const month = field("month");
  const week = field("week");
  const agenda = field("agenda");
  const empty = field("empty");
  const current = view();
  drawnAt = Date.now();

  // Dated todos are something to look at too, calendars or not.
  const hasSources =
    mine.calendars.length > 0 ||
    store.data.sources.length > 0 ||
    (store.data.todos &&
      todos.data.todos.some(
        // A deadline is only drawn while its todo is open and deadlines are on.
        (todo) => todo.date || (store.data.deadlines && todo.deadline && !todo.done),
      ));
  empty.hidden = hasSources;
  month.hidden = !hasSources || current !== "month";
  const grid = current === "week" || current === "day";
  week.hidden = !hasSources || !grid;
  week.setAttribute("aria-label", current === "day" ? "Day" : "Week");
  agenda.hidden = !hasSources || current !== "agenda";

  for (const name of VIEWS) {
    action(`view-${name}`).setAttribute("aria-pressed", String(name === current));
  }

  if (hasSources) {
    const ctx = context();
    if (current === "month") {
      field("title").textContent = monthFmt.format(anchor);
      renderMonth(month, anchor, ctx);
    } else if (grid) {
      const { start, days } = gridRange();
      field("title").textContent = days === 1 ? fullFmt.format(start) : weekTitle(start, days);
      renderWeek(week, template("week-chrome"), start, days, ctx);
      placeNowLine(week, start, days);
    } else {
      field("title").textContent = `From ${fullFmt.format(anchor)}`;
      renderAgenda(agenda, anchor, agendaSpan, ctx, () => {
        agendaSpan += AGENDA_DAYS;
        render();
      });
    }
  } else {
    field("title").textContent = monthFmt.format(anchor);
  }
  // Only the render right after the tick plays it; a resize must not replay it.
  ticked = "";

  renderSources();
}

function setView(next: View): void {
  closeDetail();
  store.data.view = next;
  store.save();
  render();
}

// --------------------------------------------------------------- sidebar --

let editing: Source | "new" | null = null;

const isSheet = (): boolean => document.body.classList.contains("is-sheet");

/**
 * Show or hide the calendar list. Docked it is simply always there; as a
 * sheet it covers the view, so it gets a scrim to say so and to give the
 * whole calendar back as a way out.
 */
function showSources(open: boolean): void {
  const side = field("side");
  side.hidden = isSheet() && !open;
  field("scrim").hidden = !isSheet() || !open;
  action("sources").setAttribute("aria-expanded", String(!side.hidden));
}

/** Close the sheet and hand focus back to the button that opened it. */
function closeSources(): void {
  showSources(false);
  action("sources").focus();
}

function ago(at: number): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) return format.format(Math.round(value), unit);
    value /= step;
  }
  return format.format(Math.round(value), "week");
}

/** The colour swatches in both editors; clicking the chosen one again unsets it. */
function paintHues(
  container: HTMLElement,
  current: () => number | undefined,
  pick: (hue: number | undefined) => void,
): void {
  container.replaceChildren();
  for (const value of HUES) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "hue";
    swatch.style.setProperty("--hue", String(value));
    swatch.setAttribute("aria-label", `Colour ${value}`);
    swatch.setAttribute("aria-pressed", String(current() === value));
    swatch.addEventListener("click", () => {
      pick(current() === value ? undefined : value);
      paintHues(container, current, pick);
    });
    container.append(swatch);
  }
}

function renderSources(): void {
  renderMine();
  const list = field("sources");
  const frag = document.createDocumentFragment();

  for (const source of store.data.sources) {
    if (editing === source) {
      frag.append(editorFor(source));
      continue;
    }
    const row = template("source-row").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
    row.style.setProperty("--hue", String(hueFor(source)));
    if (!source.enabled) row.classList.add("is-off");
    row.querySelector<HTMLElement>('[data-field="name"]')!.textContent = source.name;

    const note = row.querySelector<HTMLElement>('[data-field="note"]')!;
    if (source.lastError) {
      note.classList.add("is-error");
      // The same sentence and the same way out for everyone: a link failing
      // because the caller isn't admin must read exactly like a dead host.
      note.textContent = `${source.lastError} `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void refresh([source]));
      note.append(retry);
      if (source.kind === "url") row.title = `${source.lastError} ${IMPORT_HINT}`;
    } else if (source.lastSync) {
      note.textContent = `Synced ${ago(source.lastSync)}`;
    } else {
      note.textContent = "Not synced yet";
    }

    const toggle = row.querySelector<HTMLInputElement>('[data-action="toggle"]')!;
    toggle.checked = source.enabled;
    toggle.setAttribute("aria-label", `Show ${source.name}`);
    toggle.addEventListener("change", () => {
      source.enabled = toggle.checked;
      store.save();
      render();
    });
    row.querySelector<HTMLElement>('[data-action="menu"]')!.addEventListener("click", () => {
      editing = source;
      closeMineEditor();
      renderSources();
    });
    frag.append(row);
  }

  if (editing === "new") frag.append(editorFor(null));
  list.replaceChildren(frag);
  action("add").hidden = editing !== null || store.data.sources.length >= MAX_SOURCES;

  const open = todos.data.todos.filter((todo) => !todo.done);
  const now = new Date();
  const today = dateKey(now);
  // Counted as the Todo app groups them: a missed plan is today's, but a
  // passed deadline is late, and that is counted under Deadlines instead.
  const onToday = open.filter(
    (todo) => isForToday(todo, today) && deadlineState(todo, now) !== "late",
  ).length;
  field("todo-note").textContent = !open.length
    ? "All done"
    : [onToday ? `${onToday} today` : "", `${open.length} open`].filter(Boolean).join(" · ");
  const late = open.filter((todo) => deadlineState(todo, now) === "late").length;
  const soon = open.filter((todo) => deadlineState(todo, now) === "soon").length;
  const note = field("deadline-note");
  note.textContent =
    [late ? `${late} passed` : "", soon ? `${soon} due soon` : ""].filter(Boolean).join(" · ") ||
    "None coming up";
  note.classList.toggle("is-error", late > 0);
  (action("show-todos") as HTMLInputElement).checked = store.data.todos;
  action("show-todos").closest(".source")!.classList.toggle("is-off", !store.data.todos);
  const deadlines = action("show-deadlines") as HTMLInputElement;
  deadlines.checked = store.data.deadlines;
  deadlines.disabled = !store.data.todos;
  deadlines.closest(".source")!.classList.toggle("is-off", !store.data.todos || !store.data.deadlines);
}

function editorFor(existing: Source | null): HTMLLIElement {
  const node = template("source-editor").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const pick = <T extends HTMLElement>(selector: string) => node.querySelector<T>(selector)!;
  const urlInput = pick<HTMLInputElement>('input[name="url"]');
  const nameInput = pick<HTMLInputElement>('input[name="name"]');
  const error = pick('[data-field="error"]');

  let kind: Source["kind"] = existing?.kind ?? "url";
  let path = existing?.path ?? "";
  let hue = existing?.hue;

  if (existing) {
    urlInput.value = existing.url ?? "";
    nameInput.value = existing.name;
    pick<HTMLButtonElement>('[data-action="save"]').textContent = "Save";
    pick<HTMLElement>('[data-action="remove"]').hidden = false;
  }

  const showKind = (): void => {
    pick('[data-action="kind-url"]').setAttribute("aria-pressed", String(kind === "url"));
    pick('[data-action="kind-file"]').setAttribute("aria-pressed", String(kind === "file"));
    pick(".url-only").hidden = kind !== "url";
    pick(".file-only").hidden = kind === "file" ? false : true;
    const button = pick<HTMLButtonElement>('[data-action="pick"]');
    button.textContent = path ? path.split("/").at(-1)! : "Choose file…";
  };
  showKind();

  paintHues(pick('[data-field="hues"]'), () => hue, (next) => (hue = next));

  const close = (): void => {
    editing = null;
    renderSources();
  };

  const fail = (message: string, culprit?: HTMLElement): void => {
    error.textContent = message;
    error.hidden = false;
    culprit?.setAttribute("aria-invalid", "true");
    culprit?.focus();
  };

  const commit = (): void => {
    error.hidden = true;
    urlInput.removeAttribute("aria-invalid");

    let url: URL | null = null;
    if (kind === "url") {
      url = toIcsUrl(urlInput.value);
      if (!url) return fail("Enter a calendar link, like example.com/calendar.ics.", urlInput);
    } else if (!path) {
      return fail("Choose an .ics file to import.");
    }

    const name = nameInput.value.trim().slice(0, 60);
    const source: Source = existing ?? {
      id: newId(),
      kind,
      name: "",
      enabled: true,
      refreshMinutes: 60,
    };
    source.kind = kind;
    if (kind === "url") {
      source.url = url!.href;
      delete source.path;
    } else {
      source.path = path;
      delete source.url;
    }
    if (name) {
      source.renamed = source.name !== "" && name !== source.name ? true : source.renamed;
      source.name = name;
    } else if (!source.name) {
      source.name = kind === "url" ? guessFeedName(url!) : guessFeedName(path);
    }
    if (hue === undefined) delete source.hue;
    else source.hue = hue;

    if (!existing) store.data.sources.push(source);
    store.save();
    close();
    bumpAll();
    render();
    void refresh([source]);
  };

  pick('[data-action="kind-url"]').addEventListener("click", () => { kind = "url"; showKind(); });
  pick('[data-action="kind-file"]').addEventListener("click", () => { kind = "file"; showKind(); });
  pick('[data-action="pick"]').addEventListener("click", () => {
    // DialogOptions has no extension filter, so an .ics is confirmed after
    // the pick, by sniffing the body in sync.ts.
    void os.dialog.open({ kind: "file", title: "Import calendar" }).then((picked) => {
      if (!picked) return;
      path = picked;
      if (!nameInput.value) nameInput.value = guessFeedName(picked);
      showKind();
    });
  });
  pick('[data-action="save"]').addEventListener("click", commit);
  pick('[data-action="cancel"]').addEventListener("click", close);
  pick('[data-action="remove"]').addEventListener("click", () => {
    if (!existing) return;
    remove(existing);
    close();
  });

  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  node.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      commit();
    }
  });

  queueMicrotask(() => (kind === "url" ? urlInput : nameInput).focus());
  return node;
}

// -------------------------------------------------------- your calendars --

/** The calendar of your own being edited in the list: its id, or "new". */
let editingMine: string | null = null;
/**
 * The editor's row, kept across re-renders: the list is redrawn on every
 * minute tick, and rebuilding the row would wipe a half-typed name.
 */
let mineEditor: { key: string; node: HTMLLIElement } | null = null;

function closeMineEditor(): void {
  editingMine = null;
  mineEditor = null;
}

function eventCount(calendar: OwnCalendar): string {
  const count = calendar.events.filter((event) => event.recurrenceId === null).length;
  return count === 0 ? "No events" : count === 1 ? "1 event" : `${count} events`;
}

function renderMine(): void {
  const list = field("mine");
  // Moving the kept editor row through the fragment would drop its focus.
  const active = mineEditor?.node.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  const frag = document.createDocumentFragment();

  for (const calendar of mine.calendars) {
    if (editingMine === calendar.id) {
      frag.append(calendarEditor(calendar));
      continue;
    }
    const row = template("source-row").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
    row.style.setProperty("--hue", String(calendarHue(calendar)));
    if (calendar.hidden) row.classList.add("is-off");
    row.querySelector<HTMLElement>('[data-field="name"]')!.textContent = calendar.name;
    row.querySelector<HTMLElement>('[data-field="note"]')!.textContent = eventCount(calendar);

    const toggle = row.querySelector<HTMLInputElement>('[data-action="toggle"]')!;
    toggle.checked = !calendar.hidden;
    toggle.setAttribute("aria-label", `Show ${calendar.name}`);
    toggle.addEventListener("change", () => {
      const hidden = !toggle.checked;
      void saveMine(calendar.id, (target) => {
        target.hidden = hidden;
      });
      render();
    });
    row.querySelector<HTMLElement>('[data-action="menu"]')!.addEventListener("click", () => {
      editing = null;
      closeMineEditor();
      editingMine = calendar.id;
      renderSources();
    });
    frag.append(row);
  }

  if (editingMine === "new") frag.append(calendarEditor(null));
  list.replaceChildren(frag);
  active?.focus();
  action("new-calendar").hidden = editingMine !== null || mine.calendars.length >= MAX_CALENDARS;
}

function calendarEditor(existing: OwnCalendar | null): HTMLLIElement {
  const key = existing?.id ?? "new";
  if (mineEditor?.key === key) return mineEditor.node;

  const node = template("calendar-editor").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const pick = <T extends HTMLElement>(selector: string) => node.querySelector<T>(selector)!;
  const nameInput = pick<HTMLInputElement>('input[name="name"]');
  let hue = existing?.hue;

  if (existing) {
    nameInput.value = existing.name;
    pick<HTMLButtonElement>('[data-action="save"]').textContent = "Save";
    pick<HTMLElement>('[data-action="remove"]').hidden = false;
  }
  paintHues(pick('[data-field="hues"]'), () => hue, (next) => (hue = next));

  const close = (): void => {
    closeMineEditor();
    renderSources();
  };

  const commit = (): void => {
    const name = nameInput.value.trim().slice(0, MAX_NAME) || DEFAULT_NAME;
    if (existing) {
      void saveMine(existing.id, (target) => {
        target.name = name;
        if (hue === undefined) delete target.hue;
        else target.hue = hue;
      });
    } else {
      const calendar: OwnCalendar = {
        id: mine.newId(),
        name,
        ...(hue !== undefined && { hue }),
        hidden: false,
        events: [],
      };
      void mine.put(calendar).then(() => render(), failMine);
      // The calendar just made is the one the next event most likely goes in.
      store.data.lastCalendar = calendar.id;
      store.save();
    }
    close();
    render();
  };

  pick('[data-action="save"]').addEventListener("click", commit);
  pick('[data-action="cancel"]').addEventListener("click", close);
  pick('[data-action="remove"]').addEventListener("click", () => {
    if (!existing) return;
    close();
    // The editor row outlives re-renders, so `existing` may predate events
    // added since; Undo has to bring back the calendar as it is now.
    removeCalendar(mine.calendars.find((c) => c.id === existing.id) ?? existing);
  });
  node.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      commit();
    }
  });

  queueMicrotask(() => nameInput.focus());
  mineEditor = { key, node };
  return node;
}

/** A store write failed: say why, and redraw from what is really on disk. */
function failMine(error: unknown): void {
  console.error("[calendar]", error);
  showStatus(mineProblem(error, mine.backing), true);
  render();
}

/** Change one of your calendars. Resolves false (having said why) on failure. */
function saveMine(id: string, change: (calendar: OwnCalendar) => void): Promise<boolean> {
  return mine.update(id, change).then(
    () => {
      render();
      return true;
    },
    (error: unknown) => {
      failMine(error);
      return false;
    },
  );
}

function removeCalendar(calendar: OwnCalendar): void {
  void mine.remove(calendar.id).catch(failMine);
  render();
  showStatus(`Deleted ${calendar.name}.`, false, () => {
    // The object itself: the store replaces calendars, it never edits one.
    void mine.put(calendar).then(() => render(), failMine);
    render();
  });
}

/** Another browser, or another Calendar window, changed one of your calendars. */
async function pullMine(): Promise<void> {
  if (!(await mine.reload().catch(() => false))) return;
  render();
}

function remove(source: Source): void {
  const index = store.data.sources.indexOf(source);
  if (index < 0) return;
  const body = parsed.get(source.id);
  store.data.sources.splice(index, 1);
  parsed.delete(source.id);
  void store.dropCache(source.id);
  store.save();
  bumpAll();
  render();
  showStatus(`Removed ${source.name}.`, false, () => {
    store.data.sources.splice(Math.min(index, store.data.sources.length), 0, source);
    if (body) parsed.set(source.id, body);
    store.save();
    bumpAll();
    render();
    void refresh([source]);
  });
}

// ------------------------------------------------------------------ sync --

function bump(id: string): void {
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
}
function bumpAll(): void {
  for (const source of store.data.sources) bump(source.id);
  cacheKey = "";
  windows.clear();
}

function deps(): SyncDeps {
  return {
    os,
    store,
    onChange: (source, body) => {
      if (body !== null) {
        parsed.set(source.id, parseIcs(body).events);
        bump(source.id);
      }
      render();
    },
  };
}

/**
 * Everything overdue, plus anything this browser holds no events for: a
 * subscription that arrived from another browser has no cached body here, and
 * waiting out its refresh interval would leave it blank for an hour.
 */
function needsSync(): Source[] {
  const overdue = new Set(due(store.data.sources, Date.now()));
  return store.data.sources.filter(
    (source) => source.enabled && (overdue.has(source) || !parsed.has(source.id)),
  );
}

async function refresh(sources: readonly Source[]): Promise<void> {
  const wanted = sources.filter((source) => source.enabled);
  if (!wanted.length) return;
  showStatus(wanted.length === 1 ? `Syncing ${wanted[0]!.name}…` : "Syncing…");
  await syncMany(deps(), wanted);
  const failed = wanted.filter((source) => source.lastError);
  if (failed.length) showStatus(failed[0]!.lastError!, true);
  else showStatus("");
}

/** Reads each cached body so the views draw before any network happens. */
async function hydrate(): Promise<void> {
  for (const source of store.data.sources) {
    const body = await store.readCache(source.id);
    if (body === null) continue;
    parsed.set(source.id, parseIcs(body).events);
    bump(source.id);
    render();
    // Yield between calendars: a small holidays feed should appear while a
    // large work feed is still parsing.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Adopt the shared list when another browser has changed it. Skipped while an
 * editor is open: that row is the Source object being edited, and replacing
 * it underneath would throw the edit away mid-sentence.
 */
async function pullShared(): Promise<void> {
  if (editing !== null) return;
  if (!(await store.pull().catch(() => false))) return;

  const ids = new Set(store.data.sources.map((source) => source.id));
  for (const id of [...parsed.keys()]) if (!ids.has(id)) parsed.delete(id);
  bumpAll();
  render();
  await hydrate();
  showStatus("Calendars updated from another browser.");
  await refresh(needsSync());
}

// ----------------------------------------------------------------- todos --

/** Tick a todo off (or back on) in the Todo app's own file. */
function toggleTodo(occurrence: Occurrence): void {
  const todo = occurrence.todo;
  if (!todo) return;
  const finishing = !todo.done;
  const at = Date.now();
  // From the click itself, or the browser keeps the audio muted.
  if (finishing && todos.data.sound) pling();
  void todos
    .update((data) => {
      const target = data.todos.find((t) => t.id === todo.id);
      if (!target) return;
      target.done = finishing;
      if (finishing) target.doneAt = at;
      else delete target.doneAt;
    })
    .catch((error: unknown) => {
      console.error("[calendar]", error);
      showStatus(saveProblem(error, todos.backing), true);
      todoRev++;
      render();
    });
  todoRev++;
  // On the plan, keyed by the todo's id: a done todo's carried-over copy and
  // deadline are no longer drawn, so their own keys would light up nothing.
  ticked = finishing ? occKey({ ...occurrence, key: todo.id }) : "";
  render();
  showStatus(finishing ? `Done: ${todo.title}` : `Not done: ${todo.title}`);
}

/** The Todo app (or another browser) changed the list. */
async function pullTodos(): Promise<void> {
  if (!(await todos.reload().catch(() => false))) return;
  todoRev++;
  render();
}

/** The Projects app recoloured, added or removed a project or area. */
async function pullProjectHues(): Promise<void> {
  const next = await readProjectHues(os).catch(() => projectHues);
  if (JSON.stringify([...next]) === JSON.stringify([...projectHues])) return;
  projectHues = next;
  todoRev++;
  render();
}

// ---------------------------------------------------------------- detail --

/** "45 min", "1 hr", "4 hr 5 min" — the headline's quiet second half. */
function spanLabel(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 1) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

/** "teams.microsoft.com" for a link too long to show whole. */
function linkLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** "Friday 23 October, 17:00": a stored day, and its time when it has one. */
function dayAndTime(at: Date, timed: boolean): string {
  return timed ? `${fullFmt.format(at)}, ${time(at)}` : fullFmt.format(at);
}

/** "in 2 days", "today", "1 day late": how far off a todo's deadline is. */
function dueRelative(todo: Todo, now: Date): string {
  const days = daysBetween(now, deadlineAt(todo)!);
  if (deadlineState(todo, now) === "late") {
    return days < 0 ? `${-days} day${days === -1 ? "" : "s"} late` : "passed";
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** The popover's headline for a todo: when it's planned, or when it's due. */
function todoWhen(occurrence: Occurrence, todo: Todo, plain: string): string {
  switch (occurrence.todoPart) {
    case "deadline":
      return occurrence.allDay ? "Due by the end of the day" : `Due ${time(occurrence.start)}`;
    case "carried":
      return `Carried over from ${dayMonthFmt.format(plannedAt(todo)!)}`;
    default:
      // A todo with no length is a moment, so it gets no end time.
      if (occurrence.allDay) return "Any time";
      return todo.minutes ? plain : time(occurrence.start);
  }
}

/** The popover's second fact about a todo: the when its headline isn't. */
function todoOther(
  occurrence: Occurrence,
  todo: Todo,
): { label: string; text: string; warn: boolean } | null {
  const now = new Date();
  if (occurrence.todoPart === "deadline") {
    const plan = plannedAt(todo);
    return {
      label: "Planned",
      text: plan ? dayAndTime(plan, Boolean(todo.time)) : "Not yet",
      warn: !plan || plannedLate(todo),
    };
  }
  const due = deadlineAt(todo);
  if (!due) return null;
  const late = !todo.done && plannedLate(todo);
  return {
    label: "Due",
    text: `${dayAndTime(due, Boolean(todo.deadlineTime))}${todo.done ? "" : ` · ${dueRelative(todo, now)}`}${
      late ? ", before this plan" : ""
    }`,
    warn: late || deadlineState(todo, now) === "soon",
  };
}

/**
 * Hovering any of a todo's items -- its plan, a missed plan, its deadline --
 * lights up the rest, so a plan can be read against when it is due. Wired
 * once, on the document: the views rebuild their elements on every render.
 */
function wireTodoLinks(): void {
  let lit = "";
  const light = (id: string): void => {
    // Unless a render has rebuilt the lit elements, unlit, in the meantime.
    if (id === lit && (!id || document.querySelector(".is-linked"))) return;
    for (const node of document.querySelectorAll(".is-linked")) node.classList.remove("is-linked");
    lit = id;
    if (!id) return;
    for (const node of document.querySelectorAll(`[data-todo="${CSS.escape(id)}"]`)) {
      node.classList.add("is-linked");
    }
  };
  document.addEventListener("pointerover", (event) => {
    light((event.target as HTMLElement).closest<HTMLElement>("[data-todo]")?.dataset.todo ?? "");
  });
  // On the root element: pointerleave doesn't bubble, so the document never sees it.
  document.documentElement.addEventListener("pointerleave", () => light(""));
}

/** The occurrence the popover belongs to, so its chip can be found again. */
let detailFor = "";

const closeDetail = (): void => (field("detail") as HTMLDialogElement).close();

/** A coordinate kept inside the window, whatever size the window now is. */
const fit = (value: number, size: number, within: number): number =>
  Math.max(EDGE, Math.min(value, within - size - EDGE));

/**
 * Put the popover beside its event, inside the window.
 *
 * Called again on every resize, which is the whole point: a window can be
 * dragged narrower (or a phone turned) under an open popover, and a position
 * measured once at open time would then sit off the edge, clipped away by the
 * window frame with no way to reach it.
 */
function placeDetail(): void {
  const dialog = field("detail") as HTMLDialogElement;
  if (!dialog.open) return;

  // Phone: a sheet on the bottom edge, placed by the stylesheet alone.
  if (isPhone()) {
    dialog.style.position = "";
    dialog.style.left = "";
    dialog.style.top = "";
    return;
  }
  dialog.style.position = "fixed";

  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  // Rebuilt by every render, so it is found by key rather than held onto.
  const anchorEl = detailFor
    ? document.querySelector<HTMLElement>(`[data-occ="${CSS.escape(detailFor)}"]`)
    : null;

  // The event isn't on screen any more (its month was stepped past, say):
  // leave the popover where it is, only pulled back inside the window.
  if (!anchorEl) {
    const here = dialog.getBoundingClientRect();
    dialog.style.left = `${fit(here.left, width, innerWidth)}px`;
    dialog.style.top = `${fit(here.top, height, innerHeight)}px`;
    return;
  }

  const box = anchorEl.getBoundingClientRect();
  const below = box.bottom + GAP;
  const above = box.top - GAP - height;
  dialog.style.left = `${fit(box.left, width, innerWidth)}px`;
  // Below the event by preference, above it when the room is up there.
  dialog.style.top = `${
    below + height > innerHeight - EDGE && above >= EDGE
      ? above
      : fit(below, height, innerHeight)
  }px`;
}

function openDetail(occurrence: Occurrence): void {
  const dialog = field("detail") as HTMLDialogElement;
  const todo = occurrence.todo;
  dialog.style.setProperty("--hue", String(occurrence.hue));
  dialog.classList.toggle("is-todo", Boolean(todo));
  field("detail-title").textContent = occurrence.event.summary || "(no title)";

  // The headline is the time — what you came to the popover for — with the
  // date below it in support.
  const sameStartDay = sameDay(occurrence.start, addDays(occurrence.end, occurrence.allDay ? -1 : 0));
  const span = spanLabel(occurrence.end.getTime() - occurrence.start.getTime());
  const plain = occurrence.allDay
    ? "All day"
    : `${time(occurrence.start)} – ${time(occurrence.end)}${span ? ` · ${span}` : ""}`;
  const when = todo ? todoWhen(occurrence, todo, plain) : plain;
  const day =
    occurrence.allDay && !sameStartDay
      ? `${dayMonthFmt.format(occurrence.start)} – ${fullFmt.format(addDays(occurrence.end, -1))}`
      : fullFmt.format(occurrence.start);
  field("detail-time").textContent = when;
  field("detail-day").textContent = day;
  field("detail-time").classList.toggle(
    "is-late",
    Boolean(todo && occurrence.todoPart === "deadline" && deadlineState(todo, new Date()) === "late"),
  );

  // A todo's other when: on its plan, when it is due; on its deadline, when
  // it is planned.
  const other = todo ? todoOther(occurrence, todo) : null;
  field("prop-todo").hidden = !other;
  field("todo-label").textContent = other?.label ?? "";
  field("todo-other").textContent = other?.text ?? "";
  field("todo-other").classList.toggle("is-warn", Boolean(other?.warn));

  field("prop-where").hidden = !occurrence.event.location;
  field("detail-where").textContent = occurrence.event.location;

  field("prop-desc").hidden = !occurrence.event.description;
  field("detail-desc").textContent = occurrence.event.description;

  field("detail-swatch").style.setProperty("--hue", String(occurrence.hue));
  field("detail-swatch").classList.toggle("is-todo", Boolean(todo));
  field("detail-calendar").textContent = todo
    ? `${occurrence.sourceName}${todo.done ? " · done" : ""}`
    : occurrence.sourceName;

  const mark = action("detail-todo") as HTMLButtonElement;
  mark.hidden = !todo;
  mark.textContent = todo?.done ? "Mark as not done" : "Mark as done";
  mark.classList.toggle("primary", !todo?.done);
  mark.onclick = () => {
    closeDetail();
    toggleTodo(occurrence);
  };
  // One of your own events: edit or delete it. Anyone else's: copy it into a
  // calendar of yours, where it can be edited.
  const own = occurrence.mine && mine.calendars.some((c) => c.id === occurrence.sourceId);
  const edit = action("detail-edit") as HTMLButtonElement;
  edit.hidden = !own;
  edit.onclick = () =>
    openEventEditor({
      editing: occurrence,
      start: occurrence.start,
      end: occurrence.end,
      allDay: occurrence.allDay,
    });
  const remove = action("detail-delete") as HTMLButtonElement;
  remove.hidden = !own;
  remove.onclick = () => {
    closeDetail();
    deleteEvent(occurrence.sourceId, occurrence.event);
  };
  const copyToMine = action("copy-to-mine") as HTMLButtonElement;
  copyToMine.hidden = Boolean(todo || occurrence.mine);
  copyToMine.onclick = () =>
    openEventEditor({
      from: occurrence,
      start: occurrence.start,
      end: occurrence.end,
      allDay: occurrence.allDay,
    });

  const openTodo = action("open-todo") as HTMLButtonElement;
  openTodo.hidden = !todo;
  openTodo.onclick = () => {
    closeDetail();
    void os.process.spawn("/ProgramFiles/todo");
  };

  field("prop-url").hidden = !occurrence.event.url;
  const link = field("detail-url") as HTMLAnchorElement;
  link.textContent = linkLabel(occurrence.event.url);
  link.title = occurrence.event.url;
  link.href = occurrence.event.url || "#";
  link.onclick = (event) => {
    event.preventDefault();
    void os.shell.openExternal(occurrence.event.url);
  };

  const open = action("open-link") as HTMLButtonElement;
  open.hidden = !occurrence.event.url;
  open.onclick = () => void os.shell.openExternal(occurrence.event.url);

  (action("copy") as HTMLButtonElement).onclick = () => {
    const lines = [
      occurrence.event.summary || "(no title)",
      `${day} · ${when}`,
      occurrence.event.location,
      occurrence.event.url,
      occurrence.event.description,
    ].filter(Boolean);
    void os.clipboard.writeText(lines.join("\n")).then(
      () => showStatus("Copied."),
      () => showStatus("Couldn't copy.", true),
    );
  };

  // Each event opens at the top: the last one's description may have been
  // scrolled halfway down.
  field("detail-scroll").scrollTop = 0;

  detailFor = occKey(occurrence);
  dialog.showModal();
  placeDetail();
}

// ---------------------------------------------------------- event editor --

interface EditorInit {
  /** An occurrence of one of your own events, to edit (its whole series). */
  editing?: Occurrence;
  /** Someone else's event to start from, saved as a new one of yours. */
  from?: Occurrence;
  start: Date;
  /** Exclusive, like an occurrence's: an all-day event ends at a midnight. */
  end: Date;
  allDay: boolean;
}

/** What the open editor is changing; null for a new event. */
let eventEditing: { calendarId: string; event: CalEvent; occurrence: Date } | null = null;
/** The id a first calendar will get if this save has to make one. */
let pendingCalendarId = "";
/** End minus start as last entered, kept when the start moves. */
let eeSpan = 0;

const input = (name: string) => field(name) as HTMLInputElement;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const dayOf = (at: Date): Naive => naive(at.getFullYear(), at.getMonth() + 1, at.getDate());
const dayKeyOf = (n: Naive): string => {
  const f = fields(n);
  return `${f.y}-${pad2(f.mo)}-${pad2(f.d)}`;
};
const timeKeyOf = (at: Date): string => `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;

const newUid = (): string => `${Date.now().toString(36)}-${newId()}${newId()}`;

/** One date field, plus its time field unless all-day, as a wall clock. */
function readWall(dateName: string, timeName: string): Naive | null {
  const day = parseDate(input(dateName).value);
  if (!day) return null;
  if (input("ee-allday").checked) return dayOf(day);
  const time = input(timeName).value;
  if (!isTime(time)) return null;
  const [h, m] = time.split(":").map(Number);
  return dayOf(day) + (h! * 60 + m!) * 60_000;
}

/** All-day ends are shown inclusive (the last day) but kept exclusive. */
function readEnd(): Naive | null {
  const end = readWall("ee-end-date", "ee-end-time");
  return end !== null && input("ee-allday").checked ? addNaiveDays(end, 1) : end;
}

function writeEnd(end: Naive): void {
  const allDay = input("ee-allday").checked;
  const shown = allDay ? addNaiveDays(end, -1) : end;
  input("ee-end-date").value = dayKeyOf(shown);
  if (!allDay) {
    const f = fields(shown);
    input("ee-end-time").value = `${pad2(f.h)}:${pad2(f.mi)}`;
  }
}

function showAllDay(): void {
  const allDay = input("ee-allday").checked;
  input("ee-start-time").hidden = allDay;
  input("ee-end-time").hidden = allDay;
}

const UNITS: Record<Freq, [string, string]> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

function showRepeat(): void {
  const freq = (field("ee-repeat") as HTMLSelectElement).value as Freq | "";
  field("ee-repeat-more").hidden = !freq;
  field("ee-until-field").hidden = !freq;
  if (freq) field("ee-unit").textContent = UNITS[freq][Number(input("ee-interval").value) === 1 ? 0 : 1];
}

function paintCalendarSwatch(): void {
  const id = (field("ee-calendar") as HTMLSelectElement).value;
  const calendar = mine.calendars.find((c) => c.id === id);
  // On the dialog, not the swatch: the colour bar along its top follows too.
  field("event-editor").style.setProperty("--hue", String(calendar ? calendarHue(calendar) : hueOf(pendingCalendarId)));
}

/** Every calendar of yours, the likeliest one chosen; a first one to make if there are none. */
function fillCalendars(chosen?: string): void {
  const select = field("ee-calendar") as HTMLSelectElement;
  pendingCalendarId = mine.newId();
  const options = mine.calendars.map(
    (calendar) => new Option(calendar.hidden ? `${calendar.name} (hidden)` : calendar.name, calendar.id),
  );
  if (!options.length) options.push(new Option(DEFAULT_NAME, ""));
  select.replaceChildren(...options);
  const exists = (id: string | undefined): id is string =>
    id !== undefined && mine.calendars.some((c) => c.id === id);
  select.value =
    [chosen, store.data.lastCalendar, mine.calendars.find((c) => !c.hidden)?.id].find(exists) ??
    options[0]!.value;
  paintCalendarSwatch();
}

function eeError(message: string, culprit?: HTMLElement): void {
  const error = field("ee-error");
  error.textContent = message;
  error.hidden = false;
  if (culprit) {
    culprit.setAttribute("aria-invalid", "true");
    culprit.focus();
  }
}

function openEventEditor(init: EditorInit): void {
  closeDetail();
  const dialog = field("event-editor") as HTMLDialogElement;
  const editing = init.editing;
  const event = (editing ?? init.from)?.event;
  eventEditing = editing
    ? { calendarId: editing.sourceId, event: editing.event, occurrence: editing.start }
    : null;

  field("ee-heading").textContent = editing ? "Edit event" : init.from ? "Copy to my calendar" : "New event";
  input("ee-title").value = event?.summary ?? "";
  input("ee-location").value = event?.location ?? "";
  input("ee-url").value = event?.url ?? "";
  (field("ee-notes") as HTMLTextAreaElement).value = event?.description ?? "";

  input("ee-allday").checked = init.allDay;
  input("ee-start-date").value = dateKey(init.start);
  input("ee-start-time").value = init.allDay ? "09:00" : timeKeyOf(init.start);
  input("ee-end-time").value = init.allDay ? "10:00" : timeKeyOf(init.end);
  const start = wallOf(init.start);
  // An occurrence's end is exclusive, all-day or not; writeEnd shows it right.
  writeEnd(Math.max(wallOf(init.end), init.allDay ? addNaiveDays(start, 1) : start));
  eeSpan = Math.max(0, (readEnd() ?? start) - start);
  showAllDay();

  // A subscribed event is copied as the one occurrence that was opened.
  const repeat = editing ? repeatOf(editing.event) : null;
  (field("ee-repeat") as HTMLSelectElement).value = repeat?.freq ?? "";
  input("ee-interval").value = String(repeat?.interval ?? 1);
  input("ee-until").value = repeat?.until != null ? dayKeyOf(repeat.until) : "";
  showRepeat();

  fillCalendars(editing?.sourceId);
  action("ee-delete").hidden = !editing;
  field("ee-error").hidden = true;
  for (const node of dialog.querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");

  dialog.querySelector(".ee-scroll")!.scrollTop = 0;
  dialog.showModal();
  input("ee-title").focus();
}

function closeEventEditor(): void {
  (field("event-editor") as HTMLDialogElement).close();
  eventEditing = null;
}

/** The form -> a Draft, or null having pointed at what's wrong. */
function readDraft(): Draft | null {
  field("ee-error").hidden = true;
  for (const node of field("event-editor").querySelectorAll("[aria-invalid]")) {
    node.removeAttribute("aria-invalid");
  }
  const allDay = input("ee-allday").checked;

  const start = readWall("ee-start-date", "ee-start-time");
  if (start === null) {
    const culprit = parseDate(input("ee-start-date").value) ? input("ee-start-time") : input("ee-start-date");
    eeError(allDay || culprit === input("ee-start-date") ? "Enter the day it starts." : "Enter the time it starts.", culprit);
    return null;
  }
  const end = readEnd();
  if (end === null) {
    const culprit = parseDate(input("ee-end-date").value) ? input("ee-end-time") : input("ee-end-date");
    eeError(allDay || culprit === input("ee-end-date") ? "Enter the day it ends." : "Enter the time it ends.", culprit);
    return null;
  }
  if (end < start || (allDay && end <= start)) {
    eeError("It ends before it starts.", input("ee-end-date"));
    return null;
  }

  const url = cleanUrl(input("ee-url").value);
  if (url === null) {
    eeError("Links have to be https addresses, like https://example.com.", input("ee-url"));
    return null;
  }

  const freq = (field("ee-repeat") as HTMLSelectElement).value as Freq | "";
  let repeat: Draft["repeat"] = null;
  if (freq && FREQS.includes(freq)) {
    const interval = Number(input("ee-interval").value);
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
      eeError(`Repeat every 1 to ${MAX_INTERVAL} ${UNITS[freq][1]}.`, input("ee-interval"));
      return null;
    }
    const untilText = input("ee-until").value;
    const untilDay = untilText ? parseDate(untilText) : null;
    if (untilText && !untilDay) {
      eeError("Enter the last day it repeats, or leave it empty.", input("ee-until"));
      return null;
    }
    const until = untilDay ? dayOf(untilDay) : null;
    if (until !== null && until < startOfDay(start)) {
      eeError("It can't stop repeating before it starts.", input("ee-until"));
      return null;
    }
    repeat = { freq, interval, until };
  }

  return {
    summary: input("ee-title").value,
    location: input("ee-location").value,
    description: (field("ee-notes") as HTMLTextAreaElement).value,
    url,
    allDay,
    start,
    end,
    repeat,
  };
}

function saveEvent(): void {
  const draft = readDraft();
  if (!draft) return;
  const was = eventEditing;
  const stamp = Date.now();

  let calendarId = (field("ee-calendar") as HTMLSelectElement).value;
  let calendarName = mine.calendars.find((c) => c.id === calendarId)?.name ?? DEFAULT_NAME;
  if (!mine.calendars.some((c) => c.id === calendarId)) {
    // A first event, before any calendar of your own: make one to hold it.
    const calendar: OwnCalendar = { id: pendingCalendarId || mine.newId(), name: DEFAULT_NAME, hidden: false, events: [] };
    void mine.put(calendar).catch(failMine);
    calendarId = calendar.id;
    calendarName = calendar.name;
  }

  const event = buildEvent(draft, {
    uid: was?.event.uid ?? newUid(),
    stamp,
    zone: deviceZone(),
    base: was?.event,
    occurrence: was?.occurrence,
  });
  const same = (other: CalEvent): boolean =>
    other.uid === event.uid && other.recurrenceId === event.recurrenceId;

  const moving = was !== null && was.calendarId !== calendarId;
  // A series moves with its modified occurrences, which would otherwise stay
  // behind as stray one-off events (see groupByUid's orphans).
  const leaving = (other: CalEvent): boolean =>
    event.recurrenceId === null ? other.uid === event.uid : same(other);
  const carried = moving
    ? (mine.calendars.find((c) => c.id === was.calendarId)?.events ?? []).filter(
        (other) => leaving(other) && !same(other),
      )
    : [];

  const into = saveMine(calendarId, (calendar) => {
    // Saving into a hidden calendar would make the event vanish on the spot.
    calendar.hidden = false;
    const at = calendar.events.findIndex(same);
    if (at >= 0) calendar.events[at] = event;
    else calendar.events.push(event);
    for (const extra of carried) {
      const there = calendar.events.some(
        (other) => other.uid === extra.uid && other.recurrenceId === extra.recurrenceId,
      );
      if (!there) calendar.events.push(extra);
    }
  });
  if (moving) {
    // Moved to another calendar: only taken out of the old one once it is
    // safely in the new one.
    void into.then((ok) => {
      if (!ok) return;
      void saveMine(was.calendarId, (calendar) => {
        calendar.events = calendar.events.filter((other) => !leaving(other));
      });
    });
  }

  store.data.lastCalendar = calendarId;
  store.save();
  closeEventEditor();
  render();
  showStatus(was ? `Saved ${event.summary || "(no title)"}.` : `Added to ${calendarName}.`);
}

function deleteEvent(calendarId: string, event: CalEvent): void {
  // A whole series goes with its modified occurrences, which would otherwise
  // linger as stray one-off events (see groupByUid's orphans).
  const same = (other: CalEvent): boolean =>
    other.uid === event.uid &&
    (event.recurrenceId === null || other.recurrenceId === event.recurrenceId);
  const removed = mine.calendars.find((c) => c.id === calendarId)?.events.filter(same) ?? [event];
  void saveMine(calendarId, (calendar) => {
    calendar.events = calendar.events.filter((other) => !same(other));
  });
  render();
  showStatus(`Deleted ${event.summary || "(no title)"}.`, false, () => {
    void saveMine(calendarId, (calendar) => {
      if (!calendar.events.some(same)) calendar.events.push(...removed);
    });
  });
}

/**
 * The toolbar's New event: today when today is on screen, otherwise the day
 * in focus; at the next whole hour today, at nine on any other day.
 */
function newEventNow(): void {
  const today = midnight(new Date());
  let day: Date;
  if (view() === "month") day = focused;
  else if (view() === "agenda") day = anchor;
  else {
    const { start, days } = gridRange();
    day = today >= start && today < addDays(start, days) ? today : start;
  }
  const hour = sameDay(day, today) ? Math.min(23, new Date().getHours() + 1) : 9;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
  openEventEditor({ start, end: new Date(start.getTime() + 3_600_000), allDay: false });
}

function wireEventEditor(): void {
  const dialog = field("event-editor") as HTMLDialogElement;
  action("ee-save").addEventListener("click", saveEvent);
  action("ee-cancel").addEventListener("click", closeEventEditor);
  action("ee-delete").addEventListener("click", () => {
    const was = eventEditing;
    closeEventEditor();
    if (was) deleteEvent(was.calendarId, was.event);
  });
  dialog.addEventListener("close", () => (eventEditing = null));

  // Moving the start carries the end along with it, as in every calendar.
  const startMoved = (): void => {
    const start = readWall("ee-start-date", "ee-start-time");
    if (start !== null) writeEnd(start + eeSpan);
  };
  const endMoved = (): void => {
    const start = readWall("ee-start-date", "ee-start-time");
    const end = readEnd();
    if (start !== null && end !== null && end >= start) eeSpan = end - start;
  };
  input("ee-start-date").addEventListener("change", startMoved);
  input("ee-start-time").addEventListener("change", startMoved);
  input("ee-end-date").addEventListener("change", endMoved);
  input("ee-end-time").addEventListener("change", endMoved);
  // The fields keep their values either way: the dates read the same for
  // both, and the hidden times come back when all-day is switched off.
  input("ee-allday").addEventListener("change", () => {
    showAllDay();
    const start = readWall("ee-start-date", "ee-start-time");
    const end = readEnd();
    if (start === null) return;
    if (end === null || end <= start) {
      eeSpan = input("ee-allday").checked ? 86_400_000 : 3_600_000;
      writeEnd(start + eeSpan);
    } else eeSpan = end - start;
  });
  field("ee-repeat").addEventListener("change", showRepeat);
  input("ee-interval").addEventListener("input", showRepeat);
  field("ee-calendar").addEventListener("change", paintCalendarSwatch);

  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
      event.preventDefault();
      saveEvent();
    }
  });
}

// ---------------------------------------------------------------- status --

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false, undo?: () => void): void {
  const status = field("status");
  field("status-text").textContent = text;
  status.classList.toggle("is-error", isError);
  const button = action("undo") as HTMLButtonElement;
  button.hidden = !undo;
  if (undo) {
    button.onclick = () => {
      button.hidden = true;
      field("status-text").textContent = "";
      undo();
    };
  }
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (field("status-text").textContent === text) {
        field("status-text").textContent = "";
        button.hidden = true;
      }
    }, undo ? 8000 : 4000);
  }
}

// -------------------------------------------------------------- movement --

function step(direction: number): void {
  closeDetail();
  const current = view();
  if (current === "month") {
    anchor = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
    focused = anchor;
  } else if (current === "week") {
    anchor = addDays(anchor, direction * weekDays());
    focused = anchor;
  } else if (current === "day") {
    anchor = addDays(anchor, direction);
    focused = anchor;
  } else {
    anchor = addDays(anchor, direction * 7);
    focused = anchor;
    agendaSpan = AGENDA_DAYS;
  }
  render();
}

function goToday(): void {
  closeDetail();
  anchor = midnight(new Date());
  focused = anchor;
  agendaSpan = AGENDA_DAYS;
  render();
}

function moveFocus(days: number): void {
  focused = addDays(focused, days);
  if (view() === "month" && focused.getMonth() !== anchor.getMonth()) {
    anchor = new Date(focused.getFullYear(), focused.getMonth(), 1);
  } else if (view() === "week" || view() === "day") {
    anchor = focused;
  }
  render();
  document.querySelector<HTMLElement>(".cell[tabindex='0']")?.focus();
}

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, select, textarea, .editor, dialog")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key) {
    case "t": case "T": goToday(); break;
    case "ArrowLeft": event.preventDefault(); if (view() === "month") moveFocus(-1); else step(-1); break;
    case "ArrowRight": event.preventDefault(); if (view() === "month") moveFocus(1); else step(1); break;
    case "ArrowUp": if (view() === "month") { event.preventDefault(); moveFocus(-7); } break;
    case "ArrowDown": if (view() === "month") { event.preventDefault(); moveFocus(7); } break;
    case "Home": if (view() === "month") { event.preventDefault(); moveFocus(-((focused.getDay() + 6) % 7)); } break;
    case "End": if (view() === "month") { event.preventDefault(); moveFocus(6 - ((focused.getDay() + 6) % 7)); } break;
    case "PageUp": event.preventDefault(); step(-1); break;
    case "PageDown": event.preventDefault(); step(1); break;
    case "m": case "M": setView("month"); break;
    case "w": case "W": setView("week"); break;
    case "d": case "D": setView("day"); break;
    case "a": case "A": setView("agenda"); break;
    case "r": case "R": void refresh(store.data.sources); break;
    case "n": case "N": newEventNow(); break;
    // Double-clicking a day makes an event, so this is the keyboard's way in.
    case "Enter": if (view() === "month" && target?.classList.contains("cell")) openDay(focused); else return; break;
    case "Escape": {
      if (editing !== null) { editing = null; renderSources(); }
      else if (editingMine !== null) { closeMineEditor(); renderSources(); }
      else if (isSheet() && !field("side").hidden) closeSources();
      break;
    }
    default: return;
  }
}

// ------------------------------------------------------------------ main --

export async function main(appOs: AppInterface, args: string[] = []): Promise<void> {
  os = appOs;
  settings = await loadSettings(os);
  applyAccent(settings);
  buildFormats();

  const handle = await os.windows.create({ title: "Calendar" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = calendarHTML;

  store = await openStore(os, (message) => showStatus(message, true));
  mine = await openMine(os);
  todos = await openTodos(os);
  projectHues = await readProjectHues(os).catch(() => new Map());
  projectFileList = projectFiles((await os.process.env()).HOME ?? "/");

  // One SIGHUP handler, not followAccent's: a process gets a single handler
  // per signal, and we need the clock preference re-read as well as the
  // accent. An unhandled SIGHUP would kill us outright.
  await os.process.onSignal("SIGHUP", () => {
    void loadSettings(os).then((next) => {
      settings = next;
      applyAccent(settings);
      buildFormats();
      // The week's hour gutter is built once, so it has to go to be rebuilt.
      field("week").replaceChildren();
      render();
    });
  });

  action("today").addEventListener("click", goToday);
  action("prev").addEventListener("click", () => step(-1));
  action("next").addEventListener("click", () => step(1));
  action("refresh").addEventListener("click", () => void refresh(store.data.sources));
  for (const name of VIEWS) {
    action(`view-${name}`).addEventListener("click", () => setView(name));
  }
  action("sources").addEventListener("click", () => {
    const opening = Boolean(field("side").hidden);
    showSources(opening);
    if (opening) action("close-sources").focus();
    else action("sources").focus();
  });
  action("close-sources").addEventListener("click", closeSources);
  field("scrim").addEventListener("click", closeSources);
  const startAdd = (kind: "url" | "file"): void => {
    // The editor is a row in the list, so the list has to be on screen --
    // otherwise "Add a link" in the empty state appears to do nothing.
    showSources(true);
    editing = "new";
    renderSources();
    // Switch the editor to File first: clicking the picker alone would leave
    // it on Link, and the save would then ask for an address.
    if (kind === "file") {
      queueMicrotask(() => {
        action("kind-file").click();
        action("pick").click();
      });
    }
  };
  action("add").addEventListener("click", () => {
    closeMineEditor();
    startAdd("url");
  });
  action("new-calendar").addEventListener("click", () => {
    showSources(true);
    editing = null;
    closeMineEditor();
    editingMine = "new";
    renderSources();
  });
  action("new-event").addEventListener("click", newEventNow);
  action("empty-new-event").addEventListener("click", newEventNow);
  wireEventEditor();
  wireGrid(field("week"), {
    range: gridRange,
    create: (start, end, allDay) => openEventEditor({ start, end, allDay }),
    time,
  });
  action("show-todos").addEventListener("change", () => {
    store.data.todos = (action("show-todos") as HTMLInputElement).checked;
    store.save();
    render();
  });
  action("show-deadlines").addEventListener("change", () => {
    store.data.deadlines = (action("show-deadlines") as HTMLInputElement).checked;
    store.save();
    render();
  });
  wireTodoLinks();
  action("open-todo-app").addEventListener("click", () => void os.process.spawn("/ProgramFiles/todo"));
  action("add-link").addEventListener("click", () => {
    closeMineEditor();
    startAdd("url");
  });
  action("add-file").addEventListener("click", () => {
    closeMineEditor();
    startAdd("file");
  });
  action("close-detail").addEventListener("click", () =>
    (field("detail") as HTMLDialogElement).close(),
  );
  field("detail").addEventListener("click", (event) => {
    if (event.target === field("detail")) (field("detail") as HTMLDialogElement).close();
  });
  document.addEventListener("keydown", onKey);

  // Both layout switches in one place, so the class the stylesheet reads and
  // the state the app keeps can never disagree about which one is in force.
  const sheet = matchMedia(SHEET_QUERY);
  const phone = matchMedia(PHONE_QUERY);
  const applyMode = (): void => {
    document.body.classList.toggle("is-sheet", sheet.matches);
    document.body.classList.toggle("is-phone", phone.matches);
    // Docked, the list is always there; as a sheet it starts out of the way.
    showSources(!sheet.matches);
  };
  applyMode();
  for (const query of [sheet, phone]) {
    query.addEventListener("change", () => {
      applyMode();
      field("week").replaceChildren(); // the column count may have changed
      render();
      placeDetail();
    });
  }

  // Dragging a window edge fires this per pixel; one render per frame is
  // enough, and the popover is placed again with it.
  let frame = 0;
  addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      render();
      placeDetail();
    });
  });

  // Said plainly, and in the same breath either way: where the list is kept
  // is a fact about storage, not a hint about who is signed in.
  field("storage").textContent =
    store.backing === "cloud"
      ? "Kept in cloud storage, the same in every browser."
      : "Kept in this browser.";

  render();
  await hydrate();
  render();

  // An .ics passed on the command line (Files' "open with") is imported.
  const given = args.find((arg) => arg.endsWith(".ics"));
  if (given && !store.data.sources.some((source) => source.path === given)) {
    const source: Source = {
      id: newId(),
      kind: "file",
      path: given,
      name: guessFeedName(given),
      enabled: true,
      refreshMinutes: 60,
    };
    store.data.sources.push(source);
    store.save();
    await refresh([source]);
  }

  void refresh(needsSync());

  // The Todo app writes the same file the todos come from; follow it.
  // Your own calendars may be written by another Calendar window too.
  await os.events.subscribe(["fs.changed"], (event) => {
    if (event.path === todos.path) void pullTodos();
    else if (event.path.startsWith(`${mine.dir}/`)) void pullMine();
    else if (projectFileList.includes(event.path)) void pullProjectHues();
  });

  await os.timers.setInterval(() => {
    // Past midnight a missed plan carries over to the new today; a timed
    // deadline passed since the last draw is late now.
    const now = new Date();
    const passed = store.data.todos && todos.data.todos.some((todo) => {
      const at = !todo.done && todo.deadlineTime ? deadlineAt(todo) : null;
      return at !== null && at.getTime() > drawnAt && at <= now;
    });
    if (passed || dateKey(new Date(drawnAt)) !== dateKey(now)) render();
    if (view() === "week" || view() === "day") {
      const { start, days } = gridRange();
      placeNowLine(field("week"), start, days);
    }
    renderSources();
    void syncDue();
    void pullShared();
    void pullMine(); // nor do another browser's edits
    void pullTodos(); // another browser's ticks raise no event here
    void pullProjectHues();
  }, TICK_MS);
}

async function syncDue(): Promise<void> {
  const wanted = due(store.data.sources, Date.now());
  for (const source of wanted) await syncOne(deps(), source);
}
