// Todo — things to do, some on a day, some at a time of day.
//
// store.ts keeps the list in cloud storage when that mount will have us and
// in ~/.config otherwise. The Calendar reads the same file and draws every
// dated todo, so a todo ticked off in either place is done in both. Nothing
// in this file may branch on who is running it.
import type { AppInterface } from "../../kernel/syscalls/api";
import { applyAccent, loadSettings, type Settings } from "../../utils/settings";
import { pling } from "./pling.ts";
import {
  dateKey,
  dueAt,
  isTime,
  MAX_NOTES,
  MAX_TITLE,
  MAX_TODOS,
  newId,
  openTodos,
  parseDate,
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
}

const midnight = (at: Date): Date => new Date(at.getFullYear(), at.getMonth(), at.getDate());
const addDays = (at: Date, days: number): Date =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
/** Calendar days from `from` to `to`, by date rather than by elapsed time. */
const daysBetween = (from: Date, to: Date): number =>
  Math.round((midnight(to).getTime() - midnight(from).getTime()) / 86_400_000);

/**
 * "Thu · 9:30", "Oct 15", "Tomorrow". The group heading already names today
 * and tomorrow, so rows under it leave the day out (`withDay` false).
 */
function dueLabel(todo: Todo, now: Date, withDay: boolean): { text: string; late: boolean } {
  const at = dueAt(todo);
  if (!at) return { text: "", late: false };
  const diff = daysBetween(now, at);
  let day = "";
  if (withDay || diff < 0 || diff > 1) {
    if (diff === 0) day = "Today";
    else if (diff === 1) day = "Tomorrow";
    else if (diff === -1) day = "Yesterday";
    else if (diff > 1 && diff < 7) day = weekdayFmt.format(at);
    else if (at.getFullYear() === now.getFullYear()) day = dayMonthFmt.format(at);
    else day = dayMonthYearFmt.format(at);
  }
  const time = todo.time ? timeFmt.format(at) : "";
  const late = !todo.done && (todo.time ? at < now : diff < 0);
  return { text: [day, time].filter(Boolean).join(" · "), late };
}

// ---------------------------------------------------------------- groups --

interface Group {
  id: string;
  label: string;
  todos: Todo[];
}

/** By day, then undated-in-the-day before timed, then time, then age. */
function byDue(a: Todo, b: Todo): number {
  return (
    (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
    Number(Boolean(a.time)) - Number(Boolean(b.time)) ||
    (a.time ?? "").localeCompare(b.time ?? "") ||
    a.createdAt - b.createdAt
  );
}

/** Still on the list: not done, or done a moment ago and not yet moved. */
const isOpen = (todo: Todo): boolean => !todo.done || settling.has(todo.id);

function openGroups(todos: readonly Todo[], now: Date): Group[] {
  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));
  const groups: Group[] = [
    { id: "overdue", label: "Overdue", todos: [] },
    { id: "today", label: "Today", todos: [] },
    { id: "tomorrow", label: "Tomorrow", todos: [] },
    { id: "upcoming", label: "Upcoming", todos: [] },
    { id: "someday", label: "No date", todos: [] },
  ];
  const [overdue, onToday, onTomorrow, upcoming, someday] = groups as [Group, Group, Group, Group, Group];
  for (const todo of [...todos].filter(isOpen).sort(byDue)) {
    if (!todo.date) someday.todos.push(todo);
    else if (todo.date < today) overdue.todos.push(todo);
    else if (todo.date === today) onToday.todos.push(todo);
    else if (todo.date === tomorrow) onTomorrow.todos.push(todo);
    else upcoming.todos.push(todo);
  }
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
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || byDue(a, b));
  const left = todos.filter((todo) => !todo.done).length;

  field("subtitle").textContent = `${todayFmt.format(now)} · ${
    left ? `${left} to do` : todos.length ? "all done" : "nothing planned"
  }`;
  const sound = action("sound");
  sound.setAttribute("aria-pressed", String(store.data.sound));
  sound.title = store.data.sound ? "Sound on when finishing a todo" : "Sound off";

  const empty = field("empty");
  empty.hidden = groups.length > 0;
  field("empty-title").textContent = done.length ? "All done" : "Nothing to do";
  field("empty-text").textContent = done.length
    ? "Everything on the list is ticked off. Enjoy it."
    : "Add a todo above. Give it a date and it shows up in Calendar too.";

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

  const list = el("ul", "items");
  const withDay = group.id !== "today" && group.id !== "tomorrow";
  for (const todo of group.todos) {
    list.append(todo.id === editing ? editorFor(todo) : rowFor(todo, now, withDay));
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
      list.append(todo.id === editing ? editorFor(todo) : rowFor(todo, now, true));
    }
    section.append(list);
  }
  return section;
}

function rowFor(todo: Todo, now: Date, withDay: boolean): HTMLElement {
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

  const due = row.querySelector<HTMLElement>('[data-field="due"]')!;
  const { text, late } = dueLabel(todo, now, withDay);
  due.textContent = text;
  due.hidden = !text;
  due.classList.toggle("is-late", late);
  if (todo.time) due.classList.add("is-timed");

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
  const todo: Todo = {
    id: newId(),
    title,
    done: false,
    ...(date && { date }),
    ...(date && time && { time }),
    createdAt: Date.now(),
  };
  void store.update((data) => void data.todos.push(structuredClone(todo))).catch(onSaveError);

  titleInput.value = "";
  timeInput.value = "";
  dateInput.value = "";
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
  composer.classList.toggle(
    "is-open",
    composer.contains(document.activeElement) || Boolean(title.value || date.value || time.value),
  );
  for (const quick of composer.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
    const day = dateKey(addDays(new Date(), Number(quick.dataset.quick)));
    quick.setAttribute("aria-pressed", String(date.value === day));
  }
  date.closest(".when-field")!.classList.toggle("has-value", Boolean(date.value));
  time.closest(".when-field")!.classList.toggle("has-value", Boolean(time.value));
  action<HTMLButtonElement>("add").disabled = !title.value.trim();
}

// ---------------------------------------------------------------- editor --

function startEdit(id: string): void {
  editing = id;
  render();
}

function closeEditor(): void {
  const id = editing;
  editing = null;
  render();
  if (id) field("list").querySelector<HTMLElement>(`.item[data-id="${CSS.escape(id)}"] .item-main`)?.focus();
  if (stale) render();
}

function editorFor(todo: Todo): HTMLElement {
  const node = clone("todo-editor");
  const pick = <T extends HTMLElement>(selector: string) => node.querySelector<T>(selector)!;
  const title = pick<HTMLInputElement>('input[name="title"]');
  const notes = pick<HTMLTextAreaElement>('textarea[name="notes"]');
  const date = pick<HTMLInputElement>('input[name="date"]');
  const time = pick<HTMLInputElement>('input[name="time"]');
  const error = pick<HTMLElement>(".editor-error");

  title.value = todo.title;
  notes.value = todo.notes ?? "";
  date.value = todo.date ?? "";
  time.value = todo.time ?? "";

  for (const quick of node.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
    quick.addEventListener("click", () => {
      const which = quick.dataset.quick!;
      if (which === "none") {
        date.value = "";
        time.value = "";
      } else {
        date.value = dateKey(addDays(new Date(), Number(which)));
      }
    });
  }

  const save = (): void => {
    const nextTitle = title.value.trim().slice(0, MAX_TITLE);
    if (!nextTitle) {
      error.textContent = "Give it a title.";
      error.hidden = false;
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    const nextTime = isTime(time.value) ? time.value : "";
    const nextDate = parseDate(date.value) ? date.value : nextTime ? dateKey(new Date()) : "";
    const nextNotes = notes.value.trim().slice(0, MAX_NOTES);
    void store
      .update((data) => {
        const target = data.todos.find((t) => t.id === todo.id);
        if (!target) return;
        target.title = nextTitle;
        if (nextDate) target.date = nextDate;
        else delete target.date;
        if (nextDate && nextTime) target.time = nextTime;
        else delete target.time;
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

  queueMicrotask(() => {
    title.focus();
    title.select();
  });
  return node;
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
