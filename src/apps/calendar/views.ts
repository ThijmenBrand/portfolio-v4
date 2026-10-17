// Drawing the views. DOM only: every measurement and every bit of
// geometry comes from layout.ts, and every date comes in already decided.
//
// Everything that originates in a feed goes in through textContent. These
// bodies come off the internet and are never trusted as markup.
import { columnLayout, minutesInto, packLanes, type Span } from "./layout.ts";
import { occKey, type Occurrence } from "./query.ts";
import { deadlineAt, deadlineState, plannedLate } from "../todo/store.ts";

export const WEEK_START = 1; // ponytail: Monday, not derived from the locale
const CHIP_H = 18;
const CHIP_GAP = 2;
const DATE_H = 21;
const MIN_BOX_MINUTES = 20;
const DAY_MINUTES = 1440;
export const AGENDA_DAYS = 60;
/** A planned todo this long or longer is drawn as a block, with room for its deadline. */
const BLOCK_MINUTES = 45;

const FLAG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h8l-2 3 2 3H4" /></svg>`;

export interface ViewContext {
  /** Already expanded and cached by the caller. */
  occurrences(from: Date, to: Date): Occurrence[];
  /** Honours the user's 12/24-hour preference. */
  time(at: Date): string;
  weekday(at: Date, long?: boolean): string;
  dayMonth(at: Date): string;
  today: Date;
  /** The moment the view was drawn, which decides how pressing a deadline is. */
  now: Date;
  focused: Date;
  openDetail(occurrence: Occurrence): void;
  /** Tick a todo off, or back on. */
  toggleTodo(occurrence: Occurrence): void;
  /** occKey of the todo ticked off just now, drawn with its little flourish. */
  ticked: string;
  openDay(day: Date): void;
  focusDay(day: Date): void;
  /** Open the event editor on a new event over [start, end). */
  newEvent(start: Date, end: Date, allDay: boolean): void;
}

// --------------------------------------------------------------- dates --

/** Local midnight. Built from the parts, so it survives a DST change. */
export function midnight(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** Calendar-day arithmetic, which is not the same as adding 86 400 000 ms. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
}

export function startOfWeek(at: Date): Date {
  const day = midnight(at);
  return addDays(day, -(((day.getDay() - WEEK_START) % 7) + 7) % 7);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days from `from` to `at`, by calendar date rather than by elapsed ms. */
function dayIndex(from: Date, at: Date): number {
  return Math.round((midnight(at).getTime() - from.getTime()) / 86_400_000);
}

/**
 * The half-open day range an occurrence covers inside a window.
 *
 * An all-day event already ends at an exclusive midnight. A timed event that
 * ends exactly at midnight belongs to the day before, or every 23:00-00:00
 * meeting would paint a second, empty day.
 */
function dayRange(occurrence: Occurrence, from: Date, days: number): Span | null {
  const start = Math.max(0, dayIndex(from, occurrence.start));
  const endsAt = occurrence.end.getTime();
  const lastDay = midnight(occurrence.end).getTime() === endsAt && endsAt > occurrence.start.getTime()
    ? dayIndex(from, occurrence.end) - 1
    : dayIndex(from, occurrence.end);
  const end = Math.min(days, Math.max(start, lastDay) + 1);
  return end > start ? { start, end } : null;
}

// ----------------------------------------------------------- elements --

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Wire a chip, box or row to its occurrence. The data-occ tag is how main.ts
 * finds this element again once the view has been rebuilt under an open
 * popover -- a resize does exactly that.
 */
function opens(node: HTMLElement, occurrence: Occurrence, ctx: ViewContext): void {
  node.dataset.occ = occKey(occurrence);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    ctx.openDetail(occurrence);
  });
}

/**
 * The tick box on a todo. A span rather than a button, because it sits inside
 * the chip's own button; the popover's "Mark as done" is the keyboard route.
 */
function tickFor(occurrence: Occurrence, ctx: ViewContext): HTMLSpanElement {
  const done = occurrence.todo!.done;
  const tick = el("span", "todo-tick");
  tick.setAttribute("role", "checkbox");
  tick.setAttribute("aria-checked", String(done));
  tick.setAttribute("aria-label", occurrence.event.summary);
  tick.title = done ? "Mark as not done" : "Mark as done";
  tick.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6.2l2 2L9 4" /></svg>`;
  tick.addEventListener("click", (event) => {
    event.stopPropagation();
    ctx.toggleTodo(occurrence);
  });
  return tick;
}

/** The little flag a deadline carries where a planned todo has its tick. */
function flagFor(): HTMLSpanElement {
  const flag = el("span", "todo-flag");
  flag.innerHTML = FLAG;
  return flag;
}

/** The tick box, or the flag on a deadline. */
const markerFor = (occurrence: Occurrence, ctx: ViewContext): HTMLSpanElement =>
  occurrence.todoPart === "deadline" ? flagFor() : tickFor(occurrence, ctx);

/** "Fri 17:00", "today 17:00", "Fri": when a todo is due, said short. */
function dueText(occurrence: Occurrence, ctx: ViewContext): string {
  const todo = occurrence.todo!;
  const at = deadlineAt(todo);
  if (!at) return "";
  const day = sameDay(at, ctx.today) ? "today" : ctx.weekday(at);
  return todo.deadlineTime ? `${day} ${ctx.time(at)}` : day;
}

/**
 * Todo styling on any chip, box or agenda row: which of the todo's whens it
 * is, how pressing its deadline is, and the todo's id, which is how hovering
 * a plan lights up its deadline and the other way round (see main.ts).
 */
function markTodo(node: HTMLElement, occurrence: Occurrence, ctx: ViewContext): void {
  const todo = occurrence.todo;
  if (!todo) return;
  node.classList.add("is-todo", `is-${occurrence.todoPart ?? "plan"}`);
  node.dataset.todo = todo.id;
  if (todo.done) node.classList.add("is-done");
  if (occKey(occurrence) === ctx.ticked) node.classList.add("just-ticked");
  if (occurrence.todoPart === "deadline") {
    node.classList.add(`is-${deadlineState(todo, ctx.now) ?? "later"}`);
  } else if (!todo.done && plannedLate(todo)) {
    node.classList.add("is-planned-late");
  }
}

function chipFor(occurrence: Occurrence, ctx: ViewContext, withTime: boolean): HTMLButtonElement {
  const chip = el("button", "chip");
  chip.type = "button";
  chip.tabIndex = -1;
  chip.style.setProperty("--hue", String(occurrence.hue));
  if (occurrence.event.transparent) chip.classList.add("is-free");
  markTodo(chip, occurrence, ctx);
  if (occurrence.todo) chip.append(markerFor(occurrence, ctx));
  if (withTime && !occurrence.allDay) {
    const time = el("span", "chip-time");
    time.textContent = ctx.time(occurrence.start);
    chip.append(time);
  }
  const title = el("span", "chip-title");
  title.textContent = occurrence.event.summary || "(no title)";
  chip.append(title);
  chip.title = `${occurrence.event.summary || "(no title)"} — ${occurrence.sourceName}`;
  opens(chip, occurrence, ctx);
  return chip;
}

// ------------------------------------------------------------- month --

export function renderMonth(root: HTMLElement, anchor: Date, ctx: ViewContext): void {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const gridEnd = addDays(gridStart, 42);

  // One measurement, before any writes: interleaving reads and writes across
  // 42 cells is a 42-reflow render.
  const sample = root.querySelector<HTMLElement>(".cell");
  const cellHeight = sample?.offsetHeight ?? 0;
  const perCell = cellHeight
    ? Math.max(1, Math.floor((cellHeight - DATE_H) / (CHIP_H + CHIP_GAP)))
    : 3;

  const occurrences = ctx.occurrences(gridStart, gridEnd);
  const frag = document.createDocumentFragment();

  for (let day = 0; day < 7; day++) {
    const head = el("div", "dow");
    head.textContent = ctx.weekday(addDays(gridStart, day));
    frag.append(head);
  }

  for (let week = 0; week < 6; week++) {
    const weekStart = addDays(gridStart, week * 7);
    const weekEnd = addDays(weekStart, 7);

    // Lanes are packed across the whole week row, so a multi-day event keeps
    // one lane from Monday to Sunday instead of hopping between rows.
    const entries: { occurrence: Occurrence; span: Span }[] = [];
    for (const occurrence of occurrences) {
      if (occurrence.start >= weekEnd || occurrence.end <= weekStart) continue;
      const span = dayRange(occurrence, weekStart, 7);
      if (span) entries.push({ occurrence, span });
    }
    const lanes = packLanes(entries.map((entry) => entry.span));

    for (let day = 0; day < 7; day++) {
      const date = addDays(weekStart, day);
      const cell = el("div", "cell");
      cell.setAttribute("role", "gridcell");
      cell.tabIndex = sameDay(date, ctx.focused) ? 0 : -1;
      if (date.getMonth() !== first.getMonth()) cell.classList.add("is-outside");
      if (sameDay(date, ctx.today)) cell.classList.add("is-today");
      if (sameDay(date, ctx.focused)) cell.classList.add("is-focused");
      cell.dataset.date = String(date.getTime());

      // The date opens its day; double-clicking the rest of the cell makes an
      // event, which is what the empty space of a calendar is for.
      const number = el("span", "date");
      number.textContent = String(date.getDate());
      number.title = "Open day";
      number.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.openDay(date);
      });
      cell.append(number);

      const here = entries
        .map((entry, index) => ({ entry, lane: lanes[index]!.lane }))
        .filter(({ entry }) => entry.span.start <= day && day < entry.span.end)
        .sort((a, b) => a.lane - b.lane);

      const box = el("div", "lanes");
      const overflowing = here.length > perCell;
      const limit = overflowing ? perCell - 1 : perCell;
      let hidden = 0;

      for (const { entry, lane } of here) {
        if (lane >= limit) {
          hidden++;
          continue;
        }
        const chip = chipFor(entry.occurrence, ctx, entry.span.start === day);
        chip.style.setProperty("--lane", String(lane));
        // A bar continuing into the next cell loses its right rounding, so the
        // run reads as one bar rather than a row of separate chips.
        if (entry.span.end > day + 1) chip.classList.add("spans-right");
        box.append(chip);
      }
      if (hidden > 0) {
        const more = el("button", "more");
        more.type = "button";
        more.tabIndex = -1;
        more.textContent = `+${hidden} more`;
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          ctx.openDay(date);
        });
        more.style.setProperty("--lane", String(Math.max(0, limit)));
        box.append(more);
      }

      cell.append(box);
      cell.addEventListener("click", () => ctx.focusDay(date));
      cell.addEventListener("dblclick", (event) => {
        // Only the empty space: a chip, its tick, the date and "more" take
        // their own clicks (the same rule gestures.ts keeps for the grid).
        if ((event.target as HTMLElement).closest(".chip, .date, .more")) return;
        ctx.newEvent(date, addDays(date, 1), true);
      });
      frag.append(cell);
    }
  }

  root.replaceChildren(frag);
}

// ---------------------------------------------------------- week, day --

/**
 * The hour grid behind both the week and the day view: `days` columns from
 * `start`. The day view is this with a single column, so it gets the same
 * all-day strip, overlap layout and now-line for free.
 */
export function renderWeek(
  root: HTMLElement,
  chrome: HTMLTemplateElement,
  start: Date,
  days: number,
  ctx: ViewContext,
): void {
  const end = addDays(start, days);

  // The hour rows, gutter and column rules never change, so they are built
  // once and only the event layers are replaced. Rebuilding 24 rows on every
  // repaint is the jank everyone ships.
  let scroll = root.querySelector<HTMLElement>(".week-scroll");
  if (!scroll) {
    root.replaceChildren(chrome.content.cloneNode(true));
    const gutter = root.querySelector<HTMLElement>('[data-field="week-gutter"]')!;
    const rules = root.querySelector<HTMLElement>('[data-field="week-rules"]')!;
    for (let hour = 0; hour < 24; hour++) {
      const label = el("div", "hour");
      label.textContent = hour === 0 ? "" : ctx.time(new Date(2026, 0, 1, hour));
      gutter.append(label);
      const line = el("div", "hline");
      line.style.setProperty("--at", String(hour * 60));
      rules.append(line);
    }
    scroll = root.querySelector<HTMLElement>(".week-scroll")!;
    // Open on the working day rather than at midnight.
    requestAnimationFrame(() => {
      scroll!.scrollTop = 8 * 60 * 0.8 - 20;
    });
  }

  const rules = root.querySelector<HTMLElement>('[data-field="week-rules"]')!;
  for (const line of rules.querySelectorAll(".vline")) line.remove();
  for (let day = 1; day < days; day++) {
    const line = el("div", "vline");
    line.style.setProperty("--at", String(day));
    rules.append(line);
  }

  root.style.setProperty("--days", String(days));
  root.dataset.days = String(days);

  const heads = root.querySelector<HTMLElement>('[data-field="week-days"]')!;
  const headFrag = document.createDocumentFragment();
  for (let day = 0; day < days; day++) {
    const date = addDays(start, day);
    const head = el("div", "wday");
    if (sameDay(date, ctx.today)) head.classList.add("is-today");
    head.append(document.createTextNode(ctx.weekday(date, days === 1)));
    const number = el("b");
    number.textContent = String(date.getDate());
    head.append(number);
    if (days > 1) head.addEventListener("click", () => ctx.openDay(date));
    headFrag.append(head);
  }
  heads.replaceChildren(headFrag);

  const occurrences = ctx.occurrences(start, end);
  const allDay = occurrences.filter((occurrence) => occurrence.allDay);
  // A timed deadline is an instant, drawn as a line across its day rather
  // than as a box that would take a column from the meetings beside it.
  const isLine = (occurrence: Occurrence): boolean =>
    !occurrence.allDay && occurrence.todoPart === "deadline";
  const timed = occurrences.filter((occurrence) => !occurrence.allDay && !isLine(occurrence));
  const lines = occurrences.filter(isLine);

  // All-day strip: the same lane packing as the month grid.
  const strip = root.querySelector<HTMLElement>('[data-field="week-allday"]')!;
  const stripEntries: { occurrence: Occurrence; span: Span }[] = [];
  for (const occurrence of allDay) {
    const span = dayRange(occurrence, start, days);
    if (span) stripEntries.push({ occurrence, span });
  }
  const stripLanes = packLanes(stripEntries.map((entry) => entry.span));
  const stripFrag = document.createDocumentFragment();
  let stripDepth = 1;
  stripEntries.forEach((entry, index) => {
    const lane = stripLanes[index]!.lane;
    stripDepth = Math.max(stripDepth, lane + 1);
    if (lane >= 3) return; // the strip is capped; the rest live in the agenda
    const chip = chipFor(entry.occurrence, ctx, false);
    chip.style.setProperty("--lane", String(lane));
    chip.style.setProperty("--col", String(entry.span.start));
    chip.style.setProperty("--len", String(entry.span.end - entry.span.start));
    stripFrag.append(chip);
  });
  strip.replaceChildren(stripFrag);
  root.style.setProperty("--allday-lanes", String(Math.min(3, stripDepth)));

  // Timed events, one independent column layout per day.
  const cols = root.querySelector<HTMLElement>('[data-field="week-cols"]')!;
  const width = cols.offsetWidth / days;
  // 30px, not 48: the widening pass means most boxes end up broader than
  // their share, so three columns in a ~100px day column still read fine.
  const maxCols = Math.max(1, Math.floor(width / 30));
  const events = root.querySelector<HTMLElement>('[data-field="week-events"]')!;
  const frag = document.createDocumentFragment();

  for (let day = 0; day < days; day++) {
    const date = addDays(start, day);
    const next = addDays(start, day + 1);
    const here = timed.filter(
      (occurrence) => occurrence.start < next && occurrence.end > date,
    );
    // Measured from local midnight, never from getHours(): see layout.ts.
    const spans: Span[] = here.map((occurrence) => ({
      start: Math.max(0, minutesInto(date, occurrence.start)),
      end: Math.min(DAY_MINUTES, Math.max(minutesInto(date, occurrence.end), 0)),
    }));
    const { placed, hidden } = columnLayout(spans, maxCols);

    placed.forEach((position, index) => {
      if (!position) return;
      const occurrence = here[index]!;
      const span = spans[index]!;
      const box = el("button", "box");
      box.type = "button";
      box.tabIndex = -1;
      box.style.setProperty("--hue", String(occurrence.hue));
      box.style.setProperty("--day", String(day));
      box.style.setProperty("--col", String(position.col));
      box.style.setProperty("--span", String(position.span));
      box.style.setProperty("--total", String(position.total));
      box.style.setProperty("--start", String(span.start));
      box.style.setProperty("--len", String(Math.max(span.end - span.start, MIN_BOX_MINUTES)));
      if (occurrence.event.transparent) box.classList.add("is-free");
      markTodo(box, occurrence, ctx);

      const title = el("b");
      title.textContent = occurrence.event.summary || "(no title)";
      const when = el("span");
      when.textContent = ctx.time(occurrence.start);
      if (occurrence.todo) {
        // One line, tick first, at its time; a long plan is a block with
        // room under that line for when it is due.
        const head = el("span", "todo-head");
        head.append(tickFor(occurrence, ctx), when, title);
        box.append(head);
        const due = dueText(occurrence, ctx);
        if (span.end - span.start >= BLOCK_MINUTES) {
          box.classList.add("is-block");
          if (due && !occurrence.todo.done) {
            const line = el("span", "todo-due");
            line.innerHTML = FLAG;
            line.append(box.classList.contains("is-planned-late") ? `after its deadline, ${due}` : `due ${due}`);
            box.append(line);
          }
        }
      } else box.append(title, when);
      opens(box, occurrence, ctx);
      frag.append(box);
    });

    for (const occurrence of lines) {
      if (occurrence.start < date || occurrence.start >= next) continue;
      const line = el("button", "deadline-line");
      line.type = "button";
      line.tabIndex = -1;
      line.style.setProperty("--day", String(day));
      line.style.setProperty("--start", String(minutesInto(date, occurrence.start)));
      markTodo(line, occurrence, ctx);
      const flag = el("span", "deadline-flag");
      const when = el("span", "deadline-time");
      when.textContent = ctx.time(occurrence.start);
      const title = el("b");
      title.textContent = occurrence.event.summary || "(no title)";
      flag.append(flagFor(), when, title);
      line.append(flag);
      line.title = `Due ${ctx.time(occurrence.start)}: ${occurrence.event.summary}`;
      opens(line, occurrence, ctx);
      frag.append(line);
    }

    if (hidden.length) {
      const more = el("button", "week-overflow");
      more.type = "button";
      more.tabIndex = -1;
      more.textContent = `+${hidden.length}`;
      more.style.setProperty("--day", String(day));
      more.style.setProperty("--at", String(Math.min(...hidden.map((i) => spans[i]!.start))));
      more.addEventListener("click", () => ctx.openDay(date));
      frag.append(more);
    }
  }
  events.replaceChildren(frag);
}

/** Moves the now-line without touching the DOM tree. */
export function placeNowLine(root: HTMLElement, start: Date, days: number): void {
  const line = root.querySelector<HTMLElement>('[data-field="week-now"]');
  if (!line) return;
  const now = new Date();
  const visible = now >= start && now < addDays(start, days);
  line.hidden = !visible;
  if (visible) {
    line.style.setProperty("--now", String(minutesInto(midnight(now), now)));
  }
}

// ------------------------------------------------------------ agenda --

export function renderAgenda(
  root: HTMLElement,
  anchor: Date,
  span: number,
  ctx: ViewContext,
  onMore: () => void,
): void {
  const start = midnight(anchor);
  const end = addDays(start, span);
  const occurrences = ctx.occurrences(start, end);
  const frag = document.createDocumentFragment();

  const byDay = new Map<number, Occurrence[]>();
  for (const occurrence of occurrences) {
    const range = dayRange(occurrence, start, span);
    if (!range) continue;
    for (let day = range.start; day < range.end; day++) {
      const list = byDay.get(day);
      if (list) list.push(occurrence);
      else byDay.set(day, [occurrence]);
    }
  }

  if (byDay.size === 0) {
    const empty = el("p", "agenda-empty");
    empty.textContent = `Nothing in the next ${span} days.`;
    frag.append(empty);
  }

  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const date = addDays(start, day);
    const group = el("div", "agenda-day");

    const heading = el("div", "agenda-date");
    if (sameDay(date, ctx.today)) heading.classList.add("is-today");
    heading.textContent = sameDay(date, ctx.today)
      ? `${ctx.weekday(date)} ${ctx.dayMonth(date)} · Today`
      : `${ctx.weekday(date)} ${ctx.dayMonth(date)}`;

    const list = el("ul", "agenda-list");
    for (const occurrence of byDay.get(day)!) {
      const item = document.createElement("li");
      const row = el("button", "agenda-row");
      row.type = "button";
      row.style.setProperty("--hue", String(occurrence.hue));

      markTodo(row, occurrence, ctx);

      const when = el("span", "when");
      if (occurrence.todoPart === "deadline") {
        when.textContent = occurrence.allDay ? "Due" : `Due ${ctx.time(occurrence.start)}`;
      } else if (occurrence.todoPart === "carried") when.textContent = "Carried over";
      else if (occurrence.allDay) when.textContent = "All day";
      else if (occurrence.todo && !occurrence.todo.minutes) when.textContent = ctx.time(occurrence.start);
      else if (occurrence.start < date) when.textContent = `… ${ctx.time(occurrence.end)}`;
      else if (occurrence.end.getTime() === occurrence.start.getTime()) {
        when.textContent = ctx.time(occurrence.start);
      } else when.textContent = `${ctx.time(occurrence.start)} – ${ctx.time(occurrence.end)}`;

      const what = el("span", "what");
      if (occurrence.todo) what.append(markerFor(occurrence, ctx));
      const title = el("span", "what-title");
      title.textContent = occurrence.event.summary || "(no title)";
      what.append(title);
      if (occurrence.event.location) {
        const where = el("span", "where");
        where.textContent = ` · ${occurrence.event.location}`;
        what.append(where);
      }

      row.append(when, el("span", "rule"), what);
      opens(row, occurrence, ctx);
      item.append(row);
      list.append(item);
    }

    group.append(heading, list);
    frag.append(group);
  }

  const more = el("button", "button agenda-more");
  more.type = "button";
  more.textContent = `Show ${AGENDA_DAYS} more days`;
  more.addEventListener("click", onMore);
  frag.append(more);

  root.replaceChildren(frag);
}
