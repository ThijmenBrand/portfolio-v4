// Todo — things to do, some on a day, some at a time of day, some by a
// deadline.
//
// A todo has two whens (see store.ts): the day you plan to do it, which
// orders the list, and the day it is due, which sits beside it as a chip.
// A plan that slips just carries over to today; only a passed deadline is
// drawn as late.
//
// store.ts keeps the list in cloud storage when that mount will have us and
// in ~/.config otherwise. The Calendar reads the same file and draws every
// dated todo, so a todo ticked off in either place is done in both. Nothing
// in this file may branch on who is running it.
import type { AppInterface } from "../../kernel/syscalls/api";
import { applyAccent, loadSettings, type Settings } from "../../utils/settings";
import { pling } from "./pling.ts";
import {
  addDays,
  dateKey,
  daysBetween,
  deadlineAt,
  deadlineState,
  isForToday,
  isTime,
  MAX_MINUTES,
  MAX_NOTES,
  MAX_TITLE,
  MAX_TODOS,
  newId,
  openTodos,
  parseDate,
  plannedAt,
  plannedLate,
  saveProblem,
  type Todo,
  type TodoStore,
} from "./store.ts";
import todoHTML from "./todo.html?raw";
import "../../ui/theme.css";
import "./todo.css";

const TICK_MS = 60_000;
/** How long a finished todo stays where it was, celebrating, before it moves. */
const SETTLE_MS = 900;
/** The collapse that follows; matches .is-leaving in todo.css. */
const LEAVE_MS = 240;
/** Confetti around the tick: a few, not a party. */
const SPARKS = 10;

let os: AppInterface;
let store: TodoStore;
let settings: Settings;

/** The todo whose editor is open. */
let editing: string | null = null;
let showDone = false;
/** Finished a moment ago and still in their old place: id -> its move. */
const settling = new Map<string, ReturnType<typeof setTimeout>>();
/** Drawn with an entrance on the next render. */
let arrived: string | null = null;
/** Something changed while the editor was open; draw it once that closes. */
let stale = false;

let timeFmt: Intl.DateTimeFormat;
let weekdayFmt: Intl.DateTimeFormat;
let dayMonthFmt: Intl.DateTimeFormat;
let dayMonthYearFmt: Intl.DateTimeFormat;
let todayFmt: Intl.DateTimeFormat;
let fullDayFmt: Intl.DateTimeFormat;

const field = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-field="${name}"]`)!;
const action = <T extends HTMLElement = HTMLElement>(name: string) =>
  document.querySelector<T>(`[data-action="${name}"]`)!;
const clone = (id: string) =>
  document.querySelector<HTMLTemplateElement>(`#${id}`)!.content.firstElementChild!.cloneNode(true) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// ------------------------------------------------------------ formatting --

function buildFormats(): void {
  const hour12 = !settings.clock24h;
  timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12 });
  weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  dayMonthFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  dayMonthYearFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  todayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
  fullDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const ICONS = {
  clock: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>`,
  day: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>`,
  carried: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M9 5l3 3-3 3" /></svg>`,
  warn: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l6 10.5H2z" /><path d="M8 6.5v3M8 11.3v.2" /></svg>`,
  flag: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h8l-2 3 2 3H4" /></svg>`,
};

/** "Today", "Tomorrow", "Thu", "Mon, Oct 26": a day, said relative to now. */
function dayLabel(at: Date, now: Date): string {
  const diff = daysBetween(now, at);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return weekdayFmt.format(at);
  if (at.getFullYear() === now.getFullYear()) return dayMonthFmt.format(at);
  return dayMonthYearFmt.format(at);
}

/**
 * "Thu · 9:30 – 11:00", "9:30", "Oct 15": when a todo is planned for. The
 * Today and Tomorrow groups already name the day, so rows under them leave
 * it out (`withDay` false).
 */
function planText(todo: Todo, now: Date, withDay: boolean): string {
  const at = plannedAt(todo);
  if (!at) return "";
  const day = withDay ? dayLabel(at, now) : "";
  let time = "";
  if (todo.time) {
    time = timeFmt.format(at);
    if (todo.minutes) time += ` – ${timeFmt.format(new Date(at.getTime() + todo.minutes * 60_000))}`;
  }
  return [day, time].filter(Boolean).join(" · ");
}

interface Label {
  text: string;
  icon: keyof typeof ICONS;
  kind: "plan" | "carried" | "warn" | "quiet";
}

/**
 * The line under a todo's title: its plan, or what's wrong with it. In
 * order: a plan that ends after the deadline, a plan missed and carried
 * over, a deadline today with no plan, and then just the plan.
 */
function planLabel(todo: Todo, group: string, now: Date): Label | null {
  const at = plannedAt(todo);
  const today = dateKey(now);
  const withDay = group !== "today" && group !== "tomorrow";
  if (todo.done) {
    return at ? { text: planText(todo, now, true), icon: todo.time ? "clock" : "day", kind: "quiet" } : null;
  }
  if (at && plannedLate(todo)) {
    return { text: `planned ${planText(todo, now, true)} — after its deadline`, icon: "warn", kind: "warn" };
  }
  if (at && todo.date! < today) {
    return group === "late"
      ? { text: `was planned ${dayLabel(at, now)}`, icon: "day", kind: "quiet" }
      : { text: `carried over from ${dayLabel(at, now)}`, icon: "carried", kind: "carried" };
  }
  if (!at) {
    if (group === "today") return { text: "due today, not planned", icon: "warn", kind: "warn" };
    if (group === "late") return { text: "never planned", icon: "day", kind: "quiet" };
    return null;
  }
  const text = planText(todo, now, withDay);
  return text ? { text, icon: todo.time ? "clock" : "day", kind: "plan" } : null;
}

/** "Fri 17:00 · 2d", "Yesterday · 1d late": the deadline chip. */
function dueChip(todo: Todo, now: Date): { text: string; left: string; state: string } | null {
  const at = deadlineAt(todo);
  if (!at) return null;
  const state = deadlineState(todo, now) ?? "later";
  const days = daysBetween(now, at);
  const text = [dayLabel(at, now), todo.deadlineTime ? timeFmt.format(at) : ""].filter(Boolean).join(" ");
  let left = "";
  if (!todo.done) {
    if (days > 1) left = `${days}d`;
    else if (days < 0) left = `${-days}d late`;
    else if (state === "late") left = "late";
  }
  return { text, left, state: todo.done ? "done" : state };
}

// ---------------------------------------------------------------- groups --

interface Group {
  id: string;
  label: string;
  /** Said quietly beside the label, for a group whose name needs it. */
  hint?: string;
  todos: Todo[];
}

/** By plan day, then undated-in-the-day before timed, then time, then deadline, then age. */
function byPlan(a: Todo, b: Todo): number {
  return (
    (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
    Number(Boolean(a.time)) - Number(Boolean(b.time)) ||
    (a.time ?? "").localeCompare(b.time ?? "") ||
    byDeadline(a, b)
  );
}

/** By deadline, the most pressing first, then age. */
function byDeadline(a: Todo, b: Todo): number {
  return (
    (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") ||
    (a.deadlineTime ?? "99").localeCompare(b.deadlineTime ?? "99") ||
    a.createdAt - b.createdAt
  );
}

/** Still on the list: not done, or done a moment ago and not yet moved. */
const isOpen = (todo: Todo): boolean => !todo.done || settling.has(todo.id);

/**
 * The open todos, by when you'll do them. A missed plan isn't late -- it
 * carries over into Today -- but a passed deadline is, and those lead the
 * list whatever their plan. A deadline today puts a todo on Today too, so it
 * can't be missed for lack of a plan; other deadlines with no plan wait in
 * "Needs a plan".
 */
function openGroups(todos: readonly Todo[], now: Date): Group[] {
  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));
  const groups: Group[] = [
    { id: "late", label: "Past deadline", todos: [] },
    { id: "today", label: "Today", todos: [] },
    { id: "tomorrow", label: "Tomorrow", todos: [] },
    { id: "upcoming", label: "Upcoming", todos: [] },
    { id: "unplanned", label: "Needs a plan", hint: "due, but no day to do it", todos: [] },
    { id: "someday", label: "No date", todos: [] },
  ];
  const [late, onToday, onTomorrow, upcoming, unplanned, someday] = groups as [
    Group, Group, Group, Group, Group, Group,
  ];
  for (const todo of [...todos].filter(isOpen).sort(byPlan)) {
    // A todo ticked a moment ago is still on show, where it was: asked as if
    // still open, since deadlineState says nothing about a done todo.
    if (deadlineState({ ...todo, done: false }, now) === "late") late.todos.push(todo);
    else if (isForToday(todo, today)) onToday.todos.push(todo);
    else if (!todo.date) (todo.deadline ? unplanned : someday).todos.push(todo);
    else if (todo.date === tomorrow) onTomorrow.todos.push(todo);
    else upcoming.todos.push(todo);
  }
  late.todos.sort(byDeadline);
  unplanned.todos.sort(byDeadline);
  return groups.filter((group) => group.todos.length);
}

// ---------------------------------------------------------------- render --

/** Re-render now, or once the editor closes if one is open. */
function renderSoon(): void {
  if (editing !== null) stale = true;
  else render();
}

function render(): void {
  stale = false;
  const now = new Date();
  const todos = store.data.todos;
  const groups = openGroups(todos, now);
  const done = todos
    .filter((todo) => !isOpen(todo))
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || byPlan(a, b));
  const left = todos.filter((todo) => !todo.done).length;
  const late = todos.filter((todo) => deadlineState(todo, now) === "late").length;

  field("subtitle").textContent = [
    todayFmt.format(now),
    left ? `${left} to do` : todos.length ? "all done" : "nothing planned",
    late ? `${late} past ${late === 1 ? "its deadline" : "their deadlines"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const sound = action("sound");
  sound.setAttribute("aria-pressed", String(store.data.sound));
  sound.title = store.data.sound ? "Sound on when finishing a todo" : "Sound off";

  const empty = field("empty");
  empty.hidden = groups.length > 0;
  field("empty-title").textContent = done.length ? "All done" : "Nothing to do";
  field("empty-text").textContent = done.length
    ? "Everything on the list is ticked off. Enjoy it."
    : "Add a todo above. Give it a day to do it, or a deadline, and it shows up in Calendar too.";

  // Focus follows the todo, not the element: the rows are rebuilt.
  const active = document.activeElement as HTMLElement | null;
  const focusedRow = active?.closest<HTMLElement>(".item");
  const focusedId = focusedRow?.dataset.id;
  const focusedIndex = focusedRow ? rows().indexOf(focusedRow) : -1;
  const focusedPart = active?.classList.contains("item-main") ? ".item-main" : ".tick";

  const frag = document.createDocumentFragment();
  for (const group of groups) frag.append(groupFor(group, now));
  if (done.length) frag.append(doneGroup(done, now));
  field("list").replaceChildren(frag);
  arrived = null;

  if (focusedId !== undefined) {
    const again = field("list").querySelector<HTMLElement>(`.item[data-id="${CSS.escape(focusedId)}"] ${focusedPart}`);
    const fallback = rows()[Math.min(focusedIndex, rows().length - 1)]?.querySelector<HTMLElement>(".tick");
    (again ?? fallback)?.focus();
  }
}

const rows = (): HTMLElement[] => [...field("list").querySelectorAll<HTMLElement>(".item")];

function groupFor(group: Group, now: Date): HTMLElement {
  const section = el("section", `group is-${group.id}`);
  const head = el("h2", "group-head");
  const label = el("span");
  label.textContent = group.label;
  const count = el("span", "group-count");
  count.textContent = String(group.todos.length);
  head.append(label, count);
  if (group.hint) {
    const hint = el("span", "group-hint");
    hint.textContent = group.hint;
    head.append(hint);
  }

  const list = el("ul", "items");
  for (const todo of group.todos) {
    list.append(todo.id === editing ? editorFor(todo) : rowFor(todo, now, group.id));
  }
  section.append(head, list);
  return section;
}

function doneGroup(done: readonly Todo[], now: Date): HTMLElement {
  const section = el("section", "group is-done-group");
  const head = el("div", "group-head");
  const toggle = el("button", "group-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(showDone));
  toggle.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>`;
  const label = el("span");
  label.textContent = "Completed";
  const count = el("span", "group-count");
  count.textContent = String(done.length);
  toggle.append(label, count);
  toggle.addEventListener("click", () => {
    showDone = !showDone;
    render();
  });
  head.append(toggle);

  if (showDone) {
    const clear = el("button", "link");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => clearDone());
    head.append(el("span", "spacer"), clear);
  }
  section.append(head);

  if (showDone) {
    const list = el("ul", "items");
    for (const todo of done) {
      list.append(todo.id === editing ? editorFor(todo) : rowFor(todo, now, "done"));
    }
    section.append(list);
  }
  return section;
}

function rowFor(todo: Todo, now: Date, group: string): HTMLElement {
  const row = clone("todo-row");
  row.dataset.id = todo.id;
  row.classList.toggle("is-done", todo.done);
  if (todo.id === arrived) row.classList.add("is-new");

  const tick = row.querySelector<HTMLButtonElement>(".tick")!;
  tick.setAttribute("aria-checked", String(todo.done));
  tick.setAttribute("aria-label", todo.title);
  tick.title = todo.done ? "Mark as not done" : "Mark as done";
  tick.addEventListener("click", () => toggle(todo.id, row));

  row.querySelector<HTMLElement>('[data-field="title"]')!.textContent = todo.title;
  const notes = row.querySelector<HTMLElement>('[data-field="notes"]')!;
  notes.textContent = todo.notes?.split("\n", 1)[0] ?? "";
  notes.hidden = !todo.notes;

  const plan = row.querySelector<HTMLElement>('[data-field="plan"]')!;
  const label = planLabel(todo, group, now);
  plan.hidden = !label;
  if (label) {
    plan.className = `item-plan is-${label.kind}`;
    plan.innerHTML = ICONS[label.icon];
    plan.append(label.text);
  }

  const due = row.querySelector<HTMLElement>('[data-field="due"]')!;
  const chip = dueChip(todo, now);
  due.hidden = !chip;
  if (chip) {
    due.classList.add(`is-${chip.state}`);
    due.innerHTML = ICONS.flag;
    due.append(chip.text);
    if (chip.left) {
      const left = el("span", "due-left");
      left.textContent = ` · ${chip.left}`;
      due.append(left);
    }
    due.title = `Due ${fullDayFmt.format(deadlineAt(todo)!)}${
      todo.deadlineTime ? `, ${timeFmt.format(deadlineAt(todo)!)}` : ""
    }`;
  }

  const planButton = row.querySelector<HTMLButtonElement>('[data-action="plan"]')!;
  planButton.hidden = todo.done || Boolean(todo.date) || !todo.deadline;
  planButton.title = `Pick a day to do “${todo.title}”`;
  planButton.addEventListener("click", () => startEdit(todo.id, "date"));

  const main = row.querySelector<HTMLElement>(".item-main")!;
  main.setAttribute("aria-label", `Edit ${todo.title}`);
  main.addEventListener("click", () => startEdit(todo.id));
  const remove = row.querySelector<HTMLElement>(".item-remove")!;
  remove.setAttribute("aria-label", `Delete ${todo.title}`);
  remove.addEventListener("click", () => removeTodo(todo.id));
  return row;
}

// ---------------------------------------------------------------- ticking --

const onSaveError = (error: unknown): void => {
  console.error("[todo]", error);
  showStatus(saveProblem(error, store.backing), true);
  render();
};

/** The confetti: a ring of sparks thrown out from the tick and fading. */
function sparkle(tick: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const burst = el("span", "burst");
  burst.setAttribute("aria-hidden", "true");
  const turn = Math.random() * 360;
  for (let i = 0; i < SPARKS; i++) {
    const spark = el("i");
    spark.style.setProperty("--a", `${turn + (i * 360) / SPARKS + (Math.random() * 14 - 7)}deg`);
    spark.style.setProperty("--d", `${15 + Math.random() * 9}px`);
    spark.style.setProperty("--s", `${0.7 + Math.random() * 0.6}`);
    spark.classList.add(`c${i % 3}`);
    burst.append(spark);
  }
  tick.append(burst);
  setTimeout(() => burst.remove(), 900);
}

function toggle(id: string, row: HTMLElement): void {
  const todo = store.data.todos.find((t) => t.id === id);
  if (!todo) return;
  const finishing = !todo.done;
  const at = Date.now();

  void store
    .update((data) => {
      const target = data.todos.find((t) => t.id === id);
      if (!target) return;
      target.done = finishing;
      if (finishing) target.doneAt = at;
      else delete target.doneAt;
    })
    .catch(onSaveError);

  clearTimeout(settling.get(id));
  if (!finishing) {
    settling.delete(id);
    arrived = id;
    render();
    return;
  }

  // Called from the click itself: outside a user gesture the browser would
  // keep the audio muted.
  if (store.data.sound) pling();

  // Celebrate in place, then move the row to Completed. Drawn by hand here
  // rather than by render(), so the animation isn't rebuilt from scratch.
  const tick = row.querySelector<HTMLElement>(".tick")!;
  tick.setAttribute("aria-checked", "true");
  tick.title = "Mark as not done";
  row.classList.add("is-done", "is-ticking");
  sparkle(tick);

  settling.set(id, setTimeout(() => leave(id), SETTLE_MS));
}

/** Fold the finished row away, then let it reappear under Completed. */
function leave(id: string): void {
  const row = field("list").querySelector<HTMLElement>(`.item[data-id="${CSS.escape(id)}"]`);
  const finish = (): void => {
    settling.delete(id);
    renderSoon();
  };
  if (!row || editing !== null || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  row.style.height = `${row.offsetHeight}px`;
  void row.offsetHeight; // commit the measured height before collapsing it
  row.classList.add("is-leaving");
  setTimeout(finish, LEAVE_MS);
}

// ------------------------------------------------------------------- add --

function add(): void {
  const titleInput = field<HTMLInputElement>("new-title");
  const dateInput = field<HTMLInputElement>("new-date");
  const timeInput = field<HTMLInputElement>("new-time");
  const deadlineInput = field<HTMLInputElement>("new-deadline");
  const title = titleInput.value.trim().slice(0, MAX_TITLE);
  if (!title) {
    titleInput.focus();
    return;
  }
  if (store.data.todos.length >= MAX_TODOS) {
    showStatus("The list is full. Clear some completed todos first.", true);
    return;
  }

  // A time with no day means today: that is what anyone typing "15:00" means.
  const time = isTime(timeInput.value) ? timeInput.value : "";
  const date = parseDate(dateInput.value) ? dateInput.value : time ? dateKey(new Date()) : "";
  const deadline = parseDate(deadlineInput.value) ? deadlineInput.value : "";
  const todo: Todo = {
    id: newId(),
    title,
    done: false,
    ...(date && { date }),
    ...(date && time && { time }),
    ...(deadline && { deadline }),
    createdAt: Date.now(),
  };
  void store.update((data) => void data.todos.push(structuredClone(todo))).catch(onSaveError);

  titleInput.value = "";
  timeInput.value = "";
  dateInput.value = "";
  deadlineInput.value = "";
  arrived = todo.id;
  render();
  titleInput.focus();
  syncComposer();
}

/**
 * The when row opens while the composer has focus or holds anything, the
 * quick pills show which day is picked, and Add only lights up once there
 * is a title to add.
 */
function syncComposer(): void {
  const composer = field("composer");
  const title = field<HTMLInputElement>("new-title");
  const date = field<HTMLInputElement>("new-date");
  const time = field<HTMLInputElement>("new-time");
  const deadline = field<HTMLInputElement>("new-deadline");
  composer.classList.toggle(
    "is-open",
    composer.contains(document.activeElement) ||
      Boolean(title.value || date.value || time.value || deadline.value),
  );
  for (const quick of composer.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
    const day = dateKey(addDays(new Date(), Number(quick.dataset.quick)));
    quick.setAttribute("aria-pressed", String(date.value === day));
  }
  date.closest(".when-field")!.classList.toggle("has-value", Boolean(date.value));
  time.closest(".when-field")!.classList.toggle("has-value", Boolean(time.value));
  deadline.closest(".when-field")!.classList.toggle("has-value", Boolean(deadline.value));
  action<HTMLButtonElement>("add").disabled = !title.value.trim();
}

// ---------------------------------------------------------------- editor --

/** Which field the editor opens on: the title, the plan's day, or the deadline. */
type EditFocus = "title" | "date" | "deadline";
let editFocus: EditFocus = "title";

function startEdit(id: string, focus: EditFocus = "title"): void {
  editing = id;
  editFocus = focus;
  render();
}

function closeEditor(): void {
  const id = editing;
  editing = null;
  render();
  if (id) field("list").querySelector<HTMLElement>(`.item[data-id="${CSS.escape(id)}"] .item-main`)?.focus();
  if (stale) render();
}

/** The coming Friday, or today on a Friday: "end of the week". */
function endOfWeek(now: Date): Date {
  return addDays(now, (5 - now.getDay() + 7) % 7);
}

function editorFor(todo: Todo): HTMLElement {
  const node = clone("todo-editor");
  const pick = <T extends HTMLElement>(selector: string) => node.querySelector<T>(selector)!;
  const title = pick<HTMLInputElement>('input[name="title"]');
  const notes = pick<HTMLTextAreaElement>('textarea[name="notes"]');
  const date = pick<HTMLInputElement>('input[name="date"]');
  const time = pick<HTMLInputElement>('input[name="time"]');
  const minutes = pick<HTMLSelectElement>('select[name="minutes"]');
  const deadline = pick<HTMLInputElement>('input[name="deadline"]');
  const deadlineTime = pick<HTMLInputElement>('input[name="deadline-time"]');
  const notice = pick<HTMLElement>(".editor-notice");
  const fix = pick<HTMLButtonElement>(".notice-fix");
  const error = pick<HTMLElement>(".editor-error");

  title.value = todo.title;
  notes.value = todo.notes ?? "";
  date.value = todo.date ?? "";
  time.value = todo.time ?? "";
  deadline.value = todo.deadline ?? "";
  deadlineTime.value = todo.deadlineTime ?? "";
  // A length set by hand in the file, that the list doesn't offer, is kept.
  if (todo.minutes && ![...minutes.options].some((o) => o.value === String(todo.minutes))) {
    const option = el("option");
    option.value = String(todo.minutes);
    option.textContent = `${todo.minutes} min`;
    minutes.append(option);
  }
  minutes.value = todo.minutes ? String(todo.minutes) : "";

  /** The todo as the editor has it now. A time with no day means today. */
  const draft = (): Todo => {
    const today = dateKey(new Date());
    const nextTime = isTime(time.value) ? time.value : "";
    const nextDate = parseDate(date.value) ? date.value : nextTime ? today : "";
    const nextDeadlineTime = isTime(deadlineTime.value) ? deadlineTime.value : "";
    const nextDeadline = parseDate(deadline.value) ? deadline.value : nextDeadlineTime ? today : "";
    const length = Number(minutes.value);
    return {
      ...todo,
      date: nextDate || undefined,
      time: (nextDate && nextTime) || undefined,
      minutes: nextDate && nextTime && length > 0 ? Math.min(length, MAX_MINUTES) : undefined,
      deadline: nextDeadline || undefined,
      deadlineTime: (nextDeadline && nextDeadlineTime) || undefined,
    };
  };

  /**
   * Keep the editor honest as it is edited: a length needs a time, and a
   * plan that ends after the deadline says so, with a way to fix it -- the
   * day before the deadline, or today if that has already gone.
   */
  const sync = (): void => {
    minutes.disabled = !time.value;
    const next = draft();
    const late = plannedLate(next);
    notice.hidden = !late;
    if (!late) return;
    const now = new Date();
    const due = deadlineAt(next)!;
    const before = dateKey(addDays(due, -1));
    const target = before < dateKey(now) ? dateKey(now) : before;
    const sameDay = target === next.deadline;
    pick(".notice-text").textContent = `Planned after the deadline (${dayLabel(due, now)}${
      next.deadlineTime ? ` ${timeFmt.format(due)}` : ""
    }).`;
    // A deadline on a day already gone can't be planned before any more:
    // today would still be after it, so there is nothing to offer.
    fix.hidden = target > next.deadline!;
    if (fix.hidden) return;
    const name = dayLabel(parseDate(target)!, now);
    fix.textContent = sameDay
      ? "Do it earlier that day"
      : `Do it ${name === "Today" || name === "Tomorrow" ? name.toLowerCase() : name} instead`;
    fix.onclick = () => {
      date.value = target;
      // On the deadline's own day, a time after it can't stand; leave the
      // plan open on that day rather than guess an hour.
      if (sameDay) time.value = "";
      sync();
    };
  };

  for (const quick of node.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
    quick.addEventListener("click", () => {
      const which = quick.dataset.quick!;
      if (which === "none") {
        date.value = "";
        time.value = "";
        minutes.value = "";
      } else {
        date.value = dateKey(addDays(new Date(), Number(which)));
      }
      sync();
    });
  }
  for (const quick of node.querySelectorAll<HTMLButtonElement>("[data-due]")) {
    quick.addEventListener("click", () => {
      const which = quick.dataset.due!;
      const now = new Date();
      if (which === "none") {
        deadline.value = "";
        deadlineTime.value = "";
      } else {
        deadline.value = dateKey(which === "friday" ? endOfWeek(now) : addDays(now, Number(which)));
      }
      sync();
    });
  }
  for (const input of [date, time, minutes, deadline, deadlineTime]) {
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  }
  sync();

  const save = (): void => {
    const nextTitle = title.value.trim().slice(0, MAX_TITLE);
    if (!nextTitle) {
      error.textContent = "Give it a title.";
      error.hidden = false;
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    const next = draft();
    const nextNotes = notes.value.trim().slice(0, MAX_NOTES);
    void store
      .update((data) => {
        const target = data.todos.find((t) => t.id === todo.id);
        if (!target) return;
        target.title = nextTitle;
        for (const key of ["date", "time", "minutes", "deadline", "deadlineTime"] as const) {
          if (next[key] === undefined) delete target[key];
          else (target as unknown as Record<string, unknown>)[key] = next[key];
        }
        if (nextNotes) target.notes = nextNotes;
        else delete target.notes;
      })
      .catch(onSaveError);
    closeEditor();
  };

  pick('[data-action="editor-save"]').addEventListener("click", save);
  pick('[data-action="editor-cancel"]').addEventListener("click", closeEditor);
  pick('[data-action="editor-remove"]').addEventListener("click", () => {
    editing = null;
    removeTodo(todo.id);
  });

  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  node.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeEditor();
    else if (
      event.key === "Enter" &&
      (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      save();
    }
  });

  const focus = editFocus;
  editFocus = "title";
  queueMicrotask(() => {
    if (focus === "title") {
      title.focus();
      title.select();
    } else {
      (focus === "date" ? date : deadline).focus();
    }
  });
  return node;
}

/** T: do it today. Its time and length stay; only the day moves. */
function doToday(id: string): void {
  const today = dateKey(new Date());
  const todo = store.data.todos.find((t) => t.id === id);
  if (!todo || todo.done) return;
  if (todo.date === today) {
    showStatus("Already planned for today.");
    return;
  }
  void store
    .update((data) => {
      const target = data.todos.find((t) => t.id === id);
      if (target) target.date = today;
    })
    .catch(onSaveError);
  render();
  showStatus(`Planned for today: ${todo.title}`);
}

// ---------------------------------------------------------------- remove --

function removeTodo(id: string): void {
  const index = store.data.todos.findIndex((t) => t.id === id);
  if (index < 0) return;
  const removed = structuredClone(store.data.todos[index]!);
  clearTimeout(settling.get(id));
  settling.delete(id);
  void store.update((data) => void (data.todos = data.todos.filter((t) => t.id !== id))).catch(onSaveError);
  render();
  showStatus(`Deleted “${removed.title}”.`, false, () => {
    void store
      .update((data) => {
        if (data.todos.some((t) => t.id === removed.id)) return;
        data.todos.splice(Math.min(index, data.todos.length), 0, structuredClone(removed));
      })
      .catch(onSaveError);
    arrived = removed.id;
    render();
  });
}

function clearDone(): void {
  const removed = store.data.todos.filter((todo) => !isOpen(todo)).map((todo) => structuredClone(todo));
  if (!removed.length) return;
  const ids = new Set(removed.map((todo) => todo.id));
  void store.update((data) => void (data.todos = data.todos.filter((t) => !ids.has(t.id)))).catch(onSaveError);
  render();
  showStatus(`Cleared ${removed.length} completed.`, false, () => {
    void store
      .update((data) => {
        const have = new Set(data.todos.map((t) => t.id));
        data.todos.push(...removed.filter((t) => !have.has(t.id)).map((t) => structuredClone(t)));
      })
      .catch(onSaveError);
    render();
  });
}

// ---------------------------------------------------------------- status --

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false, undo?: () => void): void {
  const status = field("status");
  field("status-text").textContent = text;
  status.classList.toggle("is-error", isError);
  const button = action<HTMLButtonElement>("undo");
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

// ------------------------------------------------------------------ keys --

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, .editor")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const row = target?.closest<HTMLElement>(".item");
  const id = row?.dataset.id;
  switch (event.key) {
    case "n": case "N": case "/":
      event.preventDefault();
      field("new-title").focus();
      break;
    case "ArrowDown": case "ArrowUp": {
      event.preventDefault();
      const all = rows();
      if (!all.length) break;
      const at = row ? all.indexOf(row) : -1;
      const next = event.key === "ArrowDown"
        ? all[Math.min(all.length - 1, at + 1)]
        : all[Math.max(0, at < 0 ? all.length - 1 : at - 1)];
      next?.querySelector<HTMLElement>(".tick")?.focus();
      break;
    }
    case "e": case "E":
      if (id) {
        event.preventDefault();
        startEdit(id);
      }
      break;
    case "p": case "P": case "d": case "D":
      if (id) {
        event.preventDefault();
        startEdit(id, event.key.toLowerCase() === "p" ? "date" : "deadline");
      }
      break;
    case "t": case "T":
      if (id) {
        event.preventDefault();
        doToday(id);
      }
      break;
    case "Delete": case "Backspace":
      if (id) {
        event.preventDefault();
        removeTodo(id);
      }
      break;
    default:
  }
}

// ------------------------------------------------------------------ sync --

/** Another process (the Calendar, or another browser) wrote the list. */
async function pull(): Promise<void> {
  if (await store.reload().catch(() => false)) renderSoon();
}

// ------------------------------------------------------------------ main --

export async function main(appOs: AppInterface): Promise<void> {
  os = appOs;
  settings = await loadSettings(os);
  applyAccent(settings);
  buildFormats();

  const handle = await os.windows.create({ title: "Todo" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = todoHTML;

  store = await openTodos(os);

  // One SIGHUP handler, not followAccent's: the clock preference is re-read
  // as well as the accent. An unhandled SIGHUP would kill us outright.
  await os.process.onSignal("SIGHUP", () => {
    void loadSettings(os).then((next) => {
      settings = next;
      applyAccent(settings);
      buildFormats();
      renderSoon();
    });
  });

  field("storage").textContent =
    store.backing === "cloud"
      ? "Kept in cloud storage, the same in every browser."
      : "Kept in this browser.";

  const titleInput = field<HTMLInputElement>("new-title");
  for (const input of field("composer").querySelectorAll("input")) {
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        add();
      } else if (event.key === "Escape") {
        for (const each of field("composer").querySelectorAll("input")) each.value = "";
        input.blur();
      }
    });
  }
  action("add").addEventListener("click", add);

  const composer = field("composer");
  const dateInput = field<HTMLInputElement>("new-date");
  for (const quick of composer.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
    // Keep focus in the title, so picking a day never interrupts typing.
    quick.addEventListener("pointerdown", (event) => event.preventDefault());
    quick.addEventListener("click", () => {
      const day = dateKey(addDays(new Date(), Number(quick.dataset.quick)));
      dateInput.value = dateInput.value === day ? "" : day;
      syncComposer();
    });
  }
  composer.addEventListener("input", syncComposer);
  composer.addEventListener("focusin", syncComposer);
  // focusout fires before focus lands on the next element; look once it has.
  composer.addEventListener("focusout", () => setTimeout(syncComposer));

  action("sound").addEventListener("click", () => {
    const on = !store.data.sound;
    if (on) pling(); // so you hear what you turned on
    void store.update((data) => void (data.sound = on)).catch(onSaveError);
    render();
  });

  document.addEventListener("keydown", onKey);

  render();
  titleInput.focus();
  syncComposer();

  // The Calendar ticks todos off in this same file; follow it rather than poll.
  await os.events.subscribe(["fs.changed"], (event) => {
    if (event.path === store.path) void pull();
  });
  // Another browser's edits raise no event here, and the day rolls over at
  // midnight: both are picked up on the minute.
  await os.timers.setInterval(() => {
    void pull().then(() => {
      if (!settling.size) renderSoon();
    });
  }, TICK_MS);
}
