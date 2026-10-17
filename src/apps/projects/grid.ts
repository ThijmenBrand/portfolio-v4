// A small calendar of one, three or seven days: the hour grid the Today,
// Upcoming, area and project pages plan in. It shows
//
//   your calendars' events   grey, as busy time; a course's sessions in the
//                            course's colour (dashed when they don't count
//                            as busy), and an area's own calendar in the
//                            area's
//   planned todos            outlined in their project's colour
//   deadlines                a flag: a line at a timed one, a chip otherwise
//   free time                the gaps of an hour or more between 8:00 and
//                            20:00, dashed, to drop a todo into
//
// Dropping a todo on an hour plans it then; on the all-day row, plans it for
// the day with no time.
import { columnLayout } from "../calendar/layout.ts";
import { addDays, dateKey, deadlineAt, plannedAt, type Todo } from "../todo/store.ts";
import { planTodo } from "./actions.ts";
import { freeSlots, hhmm, type Span } from "./match.ts";
import { app, eventsIn, hueOfTodo, ownerOfEvent, type CalendarDays } from "./state.ts";
import { button, dropTarget, el, fmtDayMonth, fmtTime, fmtWeekday, hueColor, ICONS, lengthText, withIcon } from "./ui.ts";

export interface GridOptions {
  /** Local midnights, one per column. */
  days: Date[];
  now: Date;
  /** Pixels per hour. */
  hourPx: number;
  onOpen: (todo: Todo) => void;
  /** Draw only these todos; the rest still count as busy time. */
  only?: (todo: Todo) => boolean;
}

interface Block {
  kind: "event" | "session" | "todo" | "free";
  start: Date;
  end: Date;
  title: string;
  hue?: number;
  todo?: Todo;
  /** A session that doesn't count as busy, or an event marked free. */
  soft?: boolean;
}

interface Chip {
  kind: "event" | "session" | "todo" | "due" | "carried";
  title: string;
  hue?: number;
  todo?: Todo;
}

const SNAP_MIN = 15;

/** The hour the grid was scrolled to, so a re-render (or another range) keeps it. */
let scrolledHour: number | undefined;

export function renderGrid(root: HTMLElement, options: GridOptions): void {
  const { days, now, hourPx } = options;
  const first = days[0]!;
  const after = addDays(days.at(-1)!, 1);
  const today = dateKey(now);

  const timed: Block[][] = days.map(() => []);
  const allDay: Chip[][] = days.map(() => []);
  const deadlines: { todo: Todo; at: Date }[][] = days.map(() => []);
  const busy: Span[][] = days.map(() => []);
  const indexOf = (at: Date): number => days.findIndex((day) => dateKey(day) === dateKey(at));

  // Calendar events: busy time; course sessions and an area's own calendar in their colour.
  for (const occurrence of eventsIn(first, after)) {
    const owner = ownerOfEvent(occurrence);
    const kind = owner ? "session" : "event";
    const soft = owner?.course ? !owner.course.link!.busy : occurrence.event.transparent;
    const title = occurrence.event.summary || "(no title)";
    if (occurrence.allDay) {
      for (let day = new Date(occurrence.start); day < occurrence.end; day = addDays(day, 1)) {
        const at = indexOf(day);
        if (at !== -1) allDay[at]!.push({ kind, title, hue: owner?.hue });
      }
      continue;
    }
    const at = indexOf(occurrence.start);
    if (at === -1) continue;
    timed[at]!.push({ kind, start: occurrence.start, end: occurrence.end, title, hue: owner?.hue, soft });
    if (!soft) busy[at]!.push({ start: occurrence.start.getTime(), end: occurrence.end.getTime() });
  }

  // Todos: plans, missed plans carried to today, and open deadlines.
  for (const todo of app.todos.data.todos) {
    const plan = plannedAt(todo);
    if (options.only && !options.only(todo)) {
      if (plan && todo.time && !todo.done && todo.date! >= today) {
        const at = indexOf(plan);
        if (at !== -1) busy[at]!.push({ start: plan.getTime(), end: plan.getTime() + (todo.minutes ?? 30) * 60_000 });
      }
      continue;
    }
    const hue = hueOfTodo(todo);
    if (plan && !todo.done && todo.date! < today) {
      const at = indexOf(now);
      if (at !== -1) allDay[at]!.push({ kind: "carried", title: todo.title, hue, todo });
    } else if (plan) {
      const at = indexOf(plan);
      if (at !== -1) {
        if (todo.time) {
          const end = new Date(plan.getTime() + (todo.minutes ?? 30) * 60_000);
          timed[at]!.push({ kind: "todo", start: plan, end, title: todo.title, hue, todo });
          if (!todo.done) busy[at]!.push({ start: plan.getTime(), end: end.getTime() });
        } else {
          allDay[at]!.push({ kind: "todo", title: todo.title, hue, todo });
        }
      }
    }
    const due = deadlineAt(todo);
    if (due && !todo.done) {
      const at = indexOf(due);
      if (at === -1) continue;
      if (todo.deadlineTime) deadlines[at]!.push({ todo, at: due });
      else allDay[at]!.push({ kind: "due", title: todo.title, hue, todo });
    }
  }

  for (const [index, day] of days.entries()) {
    for (const span of freeSlots(day, busy[index]!, now)) {
      timed[index]!.push({ kind: "free", start: new Date(span.start), end: new Date(span.end), title: "" });
    }
  }

  // --------------------------------------------------------------- draw --

  const grid = el("div", `grid ${days.length === 1 ? "is-day" : days.length < 7 ? "is-few" : "is-week"}`);
  grid.style.setProperty("--cols", String(days.length));
  grid.style.setProperty("--hour", `${hourPx}px`);

  const head = el("div", "g-head");
  head.append(el("div", "g-gutter"));
  for (const day of days) {
    const cell = el("div", "g-dayhead");
    if (dateKey(day) === today) cell.classList.add("is-today");
    cell.append(el("span", "", days.length === 1 ? day.toLocaleDateString(undefined, { weekday: "long" }) : fmtWeekday(day)));
    cell.append(el("b", "", String(day.getDate())));
    head.append(cell);
  }

  const all = el("div", "g-all");
  all.append(el("div", "g-gutter", "all day"));
  for (const [index, day] of days.entries()) {
    const cell = el("div", "g-allcell");
    if (dateKey(day) === today) cell.classList.add("is-today");
    for (const chip of allDay[index]!) cell.append(chipFor(chip, options));
    dropTarget(cell, (id) => {
      planTodo(id, dateKey(day), null);
      app.render();
    });
    all.append(cell);
  }

  const scroll = el("div", "g-scroll");
  const body = el("div", "g-body");
  body.style.height = `${24 * hourPx}px`;
  const hours = el("div", "g-hours");
  for (let h = 1; h < 24; h++) {
    const label = el("span", "", app.settings.clock24h ? String(h) : fmtTime(new Date(2000, 0, 1, h)).replace(":00", ""));
    label.style.top = `${h * hourPx}px`;
    hours.append(label);
  }
  body.append(hours);

  for (const [index, day] of days.entries()) {
    const col = el("div", "g-col");
    if (dateKey(day) === today) col.classList.add("is-today");
    const blocks = timed[index]!;
    // Free time sits behind everything and takes no column of its own.
    const solid = blocks.filter((block) => block.kind !== "free");
    const minutes = (at: Date): number => (at.getTime() - day.getTime()) / 60_000;
    const { placed } = columnLayout(solid.map((block) => ({ start: minutes(block.start), end: minutes(block.end) })), 3);
    for (const block of blocks.filter((each) => each.kind === "free")) col.append(blockFor(block, day, hourPx, null, options));
    for (const [at, block] of solid.entries()) {
      const place = placed[at];
      if (place) col.append(blockFor(block, day, hourPx, place, options));
    }
    for (const { todo, at } of deadlines[index]!) {
      const line = el("div", "g-dueline");
      line.style.top = `${(minutes(at) / 60) * hourPx}px`;
      const hue = hueOfTodo(todo);
      if (hue !== undefined) line.style.setProperty("--c", hueColor(hue));
      const label = dueLabel(line, todo, options);
      label.innerHTML = withIcon(ICONS.flag, `${fmtTime(at)} ${todo.title}`);
      col.append(line);
    }
    if (dateKey(day) === today) {
      const line = el("div", "g-now");
      line.style.top = `${(minutes(now) / 60) * hourPx}px`;
      col.append(line);
    }
    dropTarget(col, (id, event) => {
      const rect = col.getBoundingClientRect();
      const minute = Math.max(0, Math.min(24 * 60 - SNAP_MIN, ((event.clientY - rect.top) / hourPx) * 60));
      const snapped = Math.round(minute / SNAP_MIN) * SNAP_MIN;
      planTodo(id, dateKey(day), hhmm(new Date(2000, 0, 1, 0, snapped)));
      app.render();
    });
    body.append(col);
  }
  scroll.append(body);
  grid.append(head, all, scroll);
  root.replaceChildren(grid);

  // Back where it was, or with the morning (or now) at the top.
  // A first visit leaves a little room so the top hour's label isn't cut off.
  const start = scrolledHour !== undefined ? scrolledHour * hourPx : Math.max(7, Math.min(now.getHours() - 1, 12)) * hourPx - 8;
  // The page is put on screen after this returns; scrolling needs it there.
  requestAnimationFrame(() => {
    scroll.scrollTop = start;
    scroll.addEventListener("scroll", () => (scrolledHour = scroll.scrollTop / hourPx), { passive: true });
  });
}

function dueLabel(parent: HTMLElement, todo: Todo, options: GridOptions): HTMLButtonElement {
  const node = el("button", "g-duelabel");
  node.type = "button";
  node.addEventListener("click", () => options.onOpen(todo));
  parent.append(node);
  return node;
}

function draggable(node: HTMLElement, todo: Todo): void {
  if (todo.done) return;
  node.draggable = true;
  node.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/x-todo", todo.id);
    event.dataTransfer!.effectAllowed = "move";
  });
}

function chipFor(chip: Chip, options: GridOptions): HTMLElement {
  const node = el(chip.todo ? "button" : "span", `g-chip is-${chip.kind}`);
  if (chip.hue !== undefined) node.style.setProperty("--c", hueColor(chip.hue));
  if (chip.kind === "due") node.innerHTML = withIcon(ICONS.flag, chip.title);
  else if (chip.kind === "carried") node.innerHTML = withIcon(ICONS.carried, chip.title);
  else node.textContent = chip.title;
  node.title = chip.kind === "carried" ? `${chip.title} (carried over)` : chip.title;
  if (chip.todo) {
    const todo = chip.todo;
    (node as HTMLButtonElement).type = "button";
    if (todo.done) node.classList.add("is-done");
    node.addEventListener("click", () => options.onOpen(todo));
    draggable(node, todo);
  }
  return node;
}

function blockFor(
  block: Block,
  day: Date,
  hourPx: number,
  place: { col: number; span: number; total: number } | null,
  options: GridOptions,
): HTMLElement {
  const node = el(block.todo ? "button" : "div", `g-block is-${block.kind}`);
  const from = (block.start.getTime() - day.getTime()) / 60_000;
  const to = Math.min(24 * 60, (block.end.getTime() - day.getTime()) / 60_000);
  node.style.top = `${(Math.max(0, from) / 60) * hourPx}px`;
  node.style.height = `${Math.max(14, ((to - Math.max(0, from)) / 60) * hourPx - 2)}px`;
  if (place) {
    node.style.left = `calc(${(place.col / place.total) * 100}% + 1px)`;
    node.style.width = `calc(${(place.span / place.total) * 100}% - 3px)`;
  }
  if (block.hue !== undefined) node.style.setProperty("--c", hueColor(block.hue));
  if (block.soft) node.classList.add("is-soft");

  if (block.kind === "free") {
    // A week's columns are too narrow for the word; the dashed box says it.
    node.append(el("span", "g-free-word", "free · "), lengthText(Math.round((block.end.getTime() - block.start.getTime()) / 60_000)));
    node.title = `Free ${fmtTime(block.start)} – ${fmtTime(block.end)}: drop a todo here to plan it`;
    return node;
  }
  const time = `${fmtTime(block.start)} – ${fmtTime(block.end)}`;
  node.title = `${block.title}\n${time}`;
  node.append(el("b", "", block.title));
  if (to - from >= 45) node.append(el("span", "", time));
  if (block.todo) {
    const todo = block.todo;
    (node as HTMLButtonElement).type = "button";
    if (todo.done) node.classList.add("is-done");
    node.addEventListener("click", () => options.onOpen(todo));
    draggable(node, todo);
  }
  return node;
}

/** The days a grid shows: `count` of them from the given day. */
export function gridDays(from: Date, count: number): Date[] {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

// ---------------------------------------------------------------- panel --

const RANGES = [
  [1, "Day"],
  [3, "3 days"],
  [7, "Week"],
] as const;

/** Narrower columns get less height per hour, so more of the day fits. */
const HOUR_PX: Record<CalendarDays, number> = { 1: 44, 3: 40, 7: 34 };

let rangeFmt: Intl.DateTimeFormat | undefined;

/**
 * The calendar beside a page's todos: a bar to step back and forth and to
 * show one, three or seven days, over the grid. Every page shares the
 * choice, so the calendar looks the same wherever you go.
 */
export function calendarPanel(options: Omit<GridOptions, "days" | "hourPx">): HTMLElement {
  const { now } = options;
  const count = app.calendarDays;
  const days = gridDays(addDays(now, app.calendarShift), count);

  const bar = el("div", "cal-bar");
  const step = (by: number) => () => {
    app.calendarShift += by;
    app.render();
  };
  const unit = count === 1 ? "day" : `${count} days`;
  const back = button("icon-button", ICONS.back, step(-count));
  back.setAttribute("aria-label", `Previous ${unit}`);
  back.title = `Previous ${unit}`;
  const next = button("icon-button", ICONS.next, step(count));
  next.setAttribute("aria-label", `Next ${unit}`);
  next.title = `Next ${unit}`;
  const home = button("cal-today", "Today", () => {
    app.calendarShift = 0;
    app.render();
  });
  home.disabled = app.calendarShift === 0;

  rangeFmt ??= new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const label = el("span", "cal-label", count === 1 ? fmtDayMonth(days[0]!) : rangeFmt.formatRange(days[0]!, days.at(-1)!));

  const range = el("div", "segmented is-small");
  range.setAttribute("role", "radiogroup");
  range.setAttribute("aria-label", "Calendar shows");
  for (const [value, text] of RANGES) {
    const pick = button("segment", text, () => {
      app.calendarDays = value;
      app.render();
    });
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(count === value));
    range.append(pick);
  }
  bar.append(home, back, next, label, range);

  const box = el("div", "grid-box");
  renderGrid(box, { ...options, days, hourPx: HOUR_PX[count] });
  const panel = el("section", "cal-panel");
  panel.setAttribute("aria-label", "Calendar");
  panel.append(bar, box);
  return panel;
}

