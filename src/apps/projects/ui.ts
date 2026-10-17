// Small pieces every page is built from: elements, icons, how dates are said,
// and the todo row. Icons are inline SVG -- nothing is loaded, and no emoji.
import { pling } from "../todo/pling.ts";
import {
  daysBetween,
  deadlineAt,
  deadlineState,
  plannedAt,
  plannedLate,
  type Todo,
} from "../todo/store.ts";
import type { Slot } from "./match.ts";
import { app, goalOf, projectOf } from "./state.ts";
import type { Project } from "./store.ts";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, label: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const node = el("button", className);
  node.type = "button";
  node.innerHTML = label;
  node.addEventListener("click", onClick);
  return node;
}

/** Text that may contain an icon: the icon's markup, then the escaped words. */
export const withIcon = (icon: string, words: string): string => `${icon}<span>${escapeHtml(words)}</span>`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const svg = (body: string): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  today: svg(`<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>`),
  upcoming: svg(`<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>`),
  day: svg(`<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>`),
  clock: svg(`<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>`),
  flag: svg(`<path d="M4 14V2.5M4 3h8l-2 3 2 3H4"/>`),
  gear: svg(`<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>`),
  plus: svg(`<path d="M8 3v10M3 8h10"/>`),
  cross: svg(`<path d="M4 4l8 8M12 4l-8 8"/>`),
  check: svg(`<path d="M3.5 8.5l3 3 6-7"/>`),
  back: svg(`<path d="M10 3L5 8l5 5"/>`),
  next: svg(`<path d="M6 3l5 5-5 5"/>`),
  down: svg(`<path d="M3.5 6l4.5 4.5L12.5 6"/>`),
  right: svg(`<path d="M6 3.5l4.5 4.5L6 12.5"/>`),
  sub: svg(`<path d="M4 3v5.5a2 2 0 0 0 2 2h6M9.5 8l2.5 2.5L9.5 13"/>`),
  carried: svg(`<path d="M3 8h9M9 5l3 3-3 3"/>`),
  warn: svg(`<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>`),
  note: svg(`<path d="M4 1.5h5.5l3 3v10h-8.5z"/><path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5"/>`),
  file: svg(`<path d="M4 1.5h5.5l3 3v10h-8.5z"/><path d="M9.5 1.5v3h3"/>`),
  image: svg(`<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>`),
  attach: svg(`<path d="M12.5 7.5l-4.8 4.8a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8L6.4 10.8a1 1 0 0 1-1.4-1.4L9.5 5"/>`),
  folder: svg(`<path d="M1.8 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>`),
  code: svg(`<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>`),
  calendar: svg(`<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>`),
  link: svg(`<path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/>`),
  trash: svg(`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>`),
  grip: svg(`<circle cx="6" cy="4" r=".6"/><circle cx="10" cy="4" r=".6"/><circle cx="6" cy="8" r=".6"/><circle cx="10" cy="8" r=".6"/><circle cx="6" cy="12" r=".6"/><circle cx="10" cy="12" r=".6"/>`),
};

// ---------------------------------------------------------------- colour --

/** A project's or area's colour, as the Calendar draws its calendars. */
export const hueColor = (hue: number, alpha?: number): string =>
  alpha === undefined ? `oklch(0.7 0.14 ${hue})` : `oklch(0.7 0.14 ${hue} / ${alpha})`;

export function dot(hue: number, className = "dot"): HTMLSpanElement {
  const node = el("span", className);
  node.style.background = hueColor(hue);
  return node;
}

/** "SOS · Software Systems" for a course with a code, else the name. */
export const projectLabel = (project: Project): string =>
  project.code ? `${project.code} · ${project.name}` : project.name;

/** The short name a tag uses: the code if there is one. */
export const shortLabel = (project: Project): string => project.code || project.name;

// ---------------------------------------------------------------- dates --

let timeFmt: Intl.DateTimeFormat;
let weekdayFmt: Intl.DateTimeFormat;
let longWeekdayFmt: Intl.DateTimeFormat;
let dayMonthFmt: Intl.DateTimeFormat;
let dayMonthYearFmt: Intl.DateTimeFormat;
let fullFmt: Intl.DateTimeFormat;

export function buildFormats(): void {
  const hour12 = !app.settings.clock24h;
  timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12 });
  weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  longWeekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  dayMonthFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  dayMonthYearFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export const fmtTime = (at: Date): string => timeFmt.format(at);
export const fmtWeekday = (at: Date): string => weekdayFmt.format(at);
export const fmtLongWeekday = (at: Date): string => longWeekdayFmt.format(at);
export const fmtDayMonth = (at: Date): string => dayMonthFmt.format(at);
export const fmtFull = (at: Date): string => fullFmt.format(at);

/** "Today", "Tomorrow", "Thu", "Mon 26 Oct": a day, said relative to now. */
export function dayLabel(at: Date, now: Date): string {
  const diff = daysBetween(now, at);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return weekdayFmt.format(at);
  if (at.getFullYear() === now.getFullYear()) return dayMonthFmt.format(at);
  return dayMonthYearFmt.format(at);
}

/** "Mondays 9:00 AM – 11:00 AM · HS 1": a course's regular weekly slot. */
export function slotLine(slot: Slot): string {
  const weekday = longWeekdayFmt.format(new Date(2024, 0, 7 + slot.weekday));
  const clock = (time: string): string => {
    const [h, m] = time.split(":").map(Number);
    return timeFmt.format(new Date(2000, 0, 1, h, m));
  };
  return [`${weekday}s ${clock(slot.from)} – ${clock(slot.to)}`, slot.location].filter(Boolean).join(" · ");
}

/** "2h", "1h 30m", "45m". */
export function lengthText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** "Mon 19 · 13:00 · 2h": when a todo is planned. */
export function planText(todo: Todo, now: Date, withDay = true): string {
  const at = plannedAt(todo);
  if (!at) return "";
  return [
    withDay ? dayLabel(at, now) : "",
    todo.time ? timeFmt.format(at) : "",
    todo.time && todo.minutes ? lengthText(todo.minutes) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Fri 30 Oct", "Fri 23:59": when it is due. */
export function dueText(todo: Todo, now: Date): string {
  const at = deadlineAt(todo);
  if (!at) return "";
  return [dayLabel(at, now), todo.deadlineTime ? timeFmt.format(at) : ""].filter(Boolean).join(" ");
}

// ------------------------------------------------------------ todo rows --

export interface RowOptions {
  /** Show which project it is in (on pages that mix projects). */
  tag?: boolean;
  /** Show which goal it is part of. */
  goal?: boolean;
  /** Leave the day out of the plan (the row sits under that day's heading). */
  noDay?: boolean;
  /** A deadline shown as the main thing (the row is in a deadlines list). */
  dueFirst?: boolean;
  onOpen: (todo: Todo) => void;
}

/** Ticks a todo off (or back on), with the Todo app's pling. */
export function setDone(todo: Todo, done: boolean): void {
  const at = Date.now();
  if (done && app.todos.data.sound) pling();
  app.save(
    app.todos.update((data) => {
      const found = data.todos.find((each) => each.id === todo.id);
      if (!found) return;
      found.done = done;
      if (done) found.doneAt = at;
      else delete found.doneAt;
    }),
    "todos",
  );
}

export function tickButton(todo: Todo): HTMLButtonElement {
  const tick = button("tick", ICONS.check, (event) => {
    event.stopPropagation();
    const row = tick.closest(".row");
    if (!todo.done) row?.classList.add("just-done");
    setDone(todo, !todo.done);
    // Let the tick draw in before the row moves to where done todos go.
    setTimeout(() => app.render(), todo.done ? 0 : 420);
  });
  tick.setAttribute("aria-label", todo.done ? `Mark "${todo.title}" not done` : `Mark "${todo.title}" done`);
  tick.setAttribute("aria-pressed", String(todo.done));
  return tick;
}

/** The deadline chip: grey while there's time, amber when soon, red once late. */
export function dueChip(todo: Todo, now: Date): HTMLSpanElement | null {
  const at = deadlineAt(todo);
  if (!at) return null;
  const state = todo.done ? "done" : deadlineState(todo, now) ?? "later";
  const chip = el("span", `due is-${state}`);
  const days = daysBetween(now, at);
  let text = dueText(todo, now);
  if (!todo.done && days < 0) text = `${text} · ${-days}d late`;
  chip.innerHTML = withIcon(ICONS.flag, text);
  chip.title = "Due";
  return chip;
}

export function projectTag(project: Project): HTMLSpanElement {
  const tag = el("span", "tag");
  tag.append(dot(project.hue), el("span", "", shortLabel(project)));
  tag.title = projectLabel(project);
  return tag;
}

export function todoRow(todo: Todo, now: Date, options: RowOptions): HTMLDivElement {
  const row = el("div", "row");
  row.dataset.id = todo.id;
  if (todo.done) row.classList.add("is-done");
  if (!todo.done) {
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/x-todo", todo.id);
      event.dataTransfer!.effectAllowed = "move";
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
  }

  const title = button("title", "", () => options.onOpen(todo));
  title.textContent = todo.title;
  row.append(tickButton(todo), title);

  if (options.goal) {
    const goal = goalOf(todo);
    if (goal) {
      const ctx = el("span", "ctx");
      ctx.innerHTML = withIcon(ICONS.sub, goal.title);
      row.append(ctx);
    }
  }
  if (options.tag) {
    const project = projectOf(todo);
    if (project) row.append(projectTag(project));
  }

  const plan = plannedAt(todo);
  if (plan && !options.dueFirst) {
    const text = el("span", "plan");
    const missed = !todo.done && daysBetween(now, plan) < 0;
    if (!todo.done && plannedLate(todo)) {
      text.classList.add("is-warn");
      text.innerHTML = withIcon(ICONS.warn, `${planText(todo, now)} — after its deadline`);
    } else if (missed) {
      text.classList.add("is-missed");
      text.innerHTML = withIcon(ICONS.carried, `from ${dayLabel(plan, now)}`);
    } else {
      text.innerHTML = withIcon(todo.time ? ICONS.clock : ICONS.day, planText(todo, now, !options.noDay));
    }
    // Under its own day's heading an untimed plan has nothing left to say.
    if (text.textContent) row.append(text);
  }
  const due = dueChip(todo, now);
  if (due) row.append(due);
  return row;
}

/** A drop of a dragged todo onto a day: keep its time, move its day. */
export function dropTarget(node: HTMLElement, onDrop: (id: string, event: DragEvent) => void): void {
  node.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("text/x-todo")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    node.classList.add("is-over");
  });
  node.addEventListener("dragleave", (event) => {
    if (!node.contains(event.relatedTarget as Node | null)) node.classList.remove("is-over");
  });
  node.addEventListener("drop", (event) => {
    node.classList.remove("is-over");
    const id = event.dataTransfer?.getData("text/x-todo");
    if (!id) return;
    event.preventDefault();
    onDrop(id, event);
  });
}

/** A section heading: "GOALS" with something quiet on the right. */
export function heading(text: string, aside?: Node | string): HTMLHeadingElement {
  const h = el("h2", "section-head", text);
  if (aside) {
    const right = el("span", "section-aside");
    right.append(aside);
    h.append(right);
  }
  return h;
}

export function empty(text: string): HTMLParagraphElement {
  return el("p", "empty-line", text);
}

/** "< Uni": back to where this page was opened from. Only on phones, unless `alwaysShown`. */
export function backButton(label: string, onClick: () => void, alwaysShown = false): HTMLButtonElement {
  return button(`back-button${alwaysShown ? " is-always" : ""}`, withIcon(ICONS.back, label), onClick);
}
