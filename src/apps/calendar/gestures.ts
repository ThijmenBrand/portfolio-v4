// Making an event by pointing at the hour grid: double-click a slot for an
// hour there, double-click the all-day strip for a day, or drag down a column
// across the time it should take.
//
// Wired once, on the week view's root, and delegated from there: the chrome
// inside it is thrown away and rebuilt when the clock setting or the column
// count changes, and listeners on the old nodes would go with it.
import { addDays } from "./views.ts";

/** Where a drag snaps to, and how far it must travel before it is a drag. */
const SNAP = 15;
const SLOT = 30;
const DRAG_PX = 4;
const DAY_MINUTES = 1440;

export interface GridTarget {
  /** The grid's first day and how many columns it shows. */
  range(): { start: Date; days: number };
  create(start: Date, end: Date, allDay: boolean): void;
  /** For the ghost box's label. */
  time(at: Date): string;
}

/** Things already in the grid, which take their own clicks. */
const TAKEN = ".box, .chip, .week-overflow, .todo-tick";

const at = (start: Date, day: number, minutes: number): Date =>
  new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, 0, minutes);

export function wireGrid(root: HTMLElement, target: GridTarget): void {
  /** The column under `x`, and how far down the day `y` is, in minutes. */
  const slotAt = (cols: HTMLElement, x: number, y: number) => {
    const { days } = target.range();
    const box = cols.getBoundingClientRect();
    const day = Math.min(days - 1, Math.max(0, Math.floor(((x - box.left) / box.width) * days)));
    const minutes = Math.min(DAY_MINUTES, Math.max(0, ((y - box.top) / box.height) * DAY_MINUTES));
    return { day, minutes };
  };

  root.addEventListener("dblclick", (event) => {
    const hit = event.target as HTMLElement;
    if (hit.closest(TAKEN)) return;
    const { start, days } = target.range();

    const strip = hit.closest<HTMLElement>(".week-allday");
    if (strip) {
      const box = strip.getBoundingClientRect();
      const day = Math.min(days - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * days)));
      const date = addDays(start, day);
      target.create(date, addDays(date, 1), true);
      return;
    }

    const cols = hit.closest<HTMLElement>(".week-cols");
    if (!cols) return;
    const { day, minutes } = slotAt(cols, event.clientX, event.clientY);
    const from = Math.min(DAY_MINUTES - 60, Math.floor(minutes / SLOT) * SLOT);
    target.create(at(start, day, from), at(start, day, from + 60), false);
  });

  root.addEventListener("pointerdown", (down) => {
    // Touch scrolls the grid; dragging out an event is a mouse and pen thing.
    if (down.button !== 0 || down.pointerType === "touch") return;
    const hit = down.target as HTMLElement;
    const cols = hit.closest<HTMLElement>(".week-cols");
    if (!cols || hit.closest(TAKEN)) return;

    const origin = slotAt(cols, down.clientX, down.clientY);
    const anchor = Math.floor(origin.minutes / SNAP) * SNAP;
    let ghost: HTMLElement | null = null;
    let span = { from: anchor, to: anchor + SNAP };

    const paint = (): void => {
      const events = root.querySelector<HTMLElement>('[data-field="week-events"]');
      if (!events) return;
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "box is-ghost";
        ghost.setAttribute("aria-hidden", "true");
        for (const [name, value] of [["--day", origin.day], ["--col", 0], ["--span", 1], ["--total", 1]]) {
          ghost.style.setProperty(name as string, String(value));
        }
      }
      // A render while dragging (the minute tick) replaces the layer it sat in.
      if (!ghost.isConnected) events.append(ghost);
      const { start } = target.range();
      ghost.style.setProperty("--start", String(span.from));
      ghost.style.setProperty("--len", String(span.to - span.from));
      ghost.textContent = `${target.time(at(start, origin.day, span.from))} – ${target.time(at(start, origin.day, span.to))}`;
    };

    const move = (event: PointerEvent): void => {
      if (!ghost && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_PX) {
        return;
      }
      // One day only: the drag stays in the column it began in.
      const { minutes } = slotAt(cols, down.clientX, event.clientY);
      const edge = Math.round(minutes / SNAP) * SNAP;
      span = edge >= anchor
        ? { from: anchor, to: Math.max(anchor + SNAP, edge) }
        : { from: edge, to: anchor + SNAP };
      paint();
    };

    const finish = (event: PointerEvent): void => {
      cols.removeEventListener("pointermove", move);
      cols.removeEventListener("pointerup", finish);
      cols.removeEventListener("pointercancel", finish);
      if (!ghost) return;
      ghost.remove();
      if (event.type === "pointercancel") return;
      const { start } = target.range();
      target.create(at(start, origin.day, span.from), at(start, origin.day, span.to), false);
    };

    cols.setPointerCapture(down.pointerId);
    cols.addEventListener("pointermove", move);
    cols.addEventListener("pointerup", finish);
    cols.addEventListener("pointercancel", finish);
  });
}
