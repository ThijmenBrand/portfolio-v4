// The new-goal card: the goal as it will look in the list, written in place.
// Its name, then its deadline -- picked from a few likely days (a week or two
// out, a course's next sessions) or from a small month. Not a native date
// field: those can't be opened from a sandboxed frame, and say "dd/mm/yyyy"
// until they are.
//
// What's typed lives here rather than in the inputs, so a redraw of the page
// (another browser's edit, the minute tick) never throws it away.
import { addDays, dateKey, daysBetween, isTime, parseDate, SOON_DAYS } from "../todo/store.ts";
import { addTodo } from "./actions.ts";
import type { Session } from "./match.ts";
import { app, sessionsFor } from "./state.ts";
import { labelOf, type Project } from "./store.ts";
import { button, el, fmtDayMonth, fmtFull, fmtTime, hueColor, ICONS, withIcon } from "./ui.ts";

interface Draft {
  project: string;
  title: string;
  /** "YYYY-MM-DD", or "" for none yet. */
  deadline: string;
  /** "HH:MM", or "" for the end of the day. */
  time: string;
  timeShown: boolean;
  /** The month the calendar shows ("YYYY-MM-01"), or null while it's shut. */
  month: string | null;
  error: string;
}

let draft: Draft | null = null;
/** What to focus once the card is drawn again, by its data-focus. */
let focusNext: string | null = null;
/** Draws the open card again where it stands. */
let redraw: ((focus?: string) => void) | null = null;

export const draftOpenFor = (projectId: string): boolean => draft?.project === projectId;

/** Opens the card on a project's page (the G key, and both "+ Goal"s). */
export function openGoalDraft(projectId: string): void {
  if (!projectId) return;
  if (draft?.project !== projectId) {
    draft = { project: projectId, title: "", deadline: "", time: "", timeShown: false, month: null, error: "" };
  }
  focusNext = "title";
  app.render();
}

function closeDraft(): void {
  draft = null;
  redraw = null;
  app.render();
}

// A click anywhere off the calendar shuts it, as a menu would. Taken out
// rather than drawn again, so the click still lands on what was under it.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (!draft?.month || (event.target as Element | null)?.closest(".due-anchor")) return;
    draft.month = null;
    document.querySelector(".minical")?.remove();
    document.querySelector(".due-pick")?.setAttribute("aria-expanded", "false");
  },
  true,
);

const monthKey = (at: Date): string => dateKey(new Date(at.getFullYear(), at.getMonth(), 1));
const midnight = (at: Date): Date => new Date(at.getFullYear(), at.getMonth(), at.getDate());
const clock = (at: Date): string => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

interface Suggestion {
  label: string;
  title: string;
  day: string;
  time?: string;
}

/** A week, two weeks, and -- for a course -- the next session of each kind. */
function suggestions(sessions: Session[], now: Date): Suggestion[] {
  const today = midnight(now);
  const out: Suggestion[] = [7, 14].map((days) => {
    const at = addDays(today, days);
    return { label: days === 7 ? "In a week" : "In 2 weeks", title: fmtFull(at), day: dateKey(at) };
  });
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.start <= now || seen.has(session.type)) continue;
    seen.add(session.type);
    out.push({
      label: `By next ${session.type || "session"}`,
      title: `${labelOf(app.projects.data, session.type)}, ${fmtFull(session.start)} ${fmtTime(session.start)}`,
      day: dateKey(session.start),
      time: clock(session.start),
    });
    if (seen.size === 2) break;
  }
  return out;
}

/** "today", "tomorrow", "in 12 days". */
function fromNow(day: Date, now: Date): string {
  const days = daysBetween(now, day);
  return days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

export function goalDraft(project: Project): HTMLElement {
  const state = draft!;
  const now = new Date();
  const today = midnight(now);
  const sessions = sessionsFor(project);

  // Drawn again while something in it had focus: keep it there.
  const active = document.activeElement as HTMLElement | null;
  if (focusNext === null && active?.closest(".goal-draft")) focusNext = active.dataset.focus ?? null;

  const card = el("section", "goal-draft");
  card.setAttribute("aria-label", "New goal");
  card.style.setProperty("--c", hueColor(project.hue));
  redraw = (focus) => {
    if (!card.isConnected) return;
    focusNext = focus ?? (document.activeElement as HTMLElement | null)?.dataset.focus ?? null;
    card.replaceWith(goalDraft(project));
  };

  const create = (): void => {
    const name = state.title.trim();
    if (!name) {
      state.error = "Give the goal a name first.";
      redraw?.("title");
      return;
    }
    const day = parseDate(state.deadline) ? state.deadline : "";
    const id = addTodo({
      title: name,
      project: project.id,
      goal: true,
      ...(day && { deadline: day }),
      ...(day && isTime(state.time) && { deadlineTime: state.time }),
    });
    draft = null;
    redraw = null;
    app.go({ view: "goal", id: project.id, goal: id }, "page");
  };

  // ---- name
  const head = el("div", "draft-head");
  const mark = el("span", "draft-mark");
  const titles = el("div", "draft-titles");
  const title = el("input", "draft-title");
  title.type = "text";
  title.placeholder = "Name the goal, e.g. Assignment 1: architecture report";
  title.setAttribute("aria-label", "Goal name");
  title.maxLength = 200;
  title.value = state.title;
  title.dataset.focus = "title";
  const sub = el("p", `draft-sub${state.error ? " is-warn" : ""}`, state.error || "You split it into parts and plan them next.");
  title.addEventListener("input", () => {
    state.title = title.value;
    if (state.error) {
      state.error = "";
      sub.className = "draft-sub";
      sub.textContent = "You split it into parts and plan them next.";
    }
  });
  if (state.error) title.setAttribute("aria-invalid", "true");
  titles.append(title, sub);
  head.append(mark, titles);

  // ---- deadline
  const due = el("div", "draft-due");
  due.append(el("span", "draft-label", "Due"));
  const anchor = el("div", "due-anchor");
  const picked = parseDate(state.deadline);
  const pick = button(`due-pick${picked ? " is-set" : ""}`, withIcon(ICONS.flag, picked ? dayText(picked, now) : "Pick a day"), () => {
    state.month = state.month ? null : monthKey(picked ?? today);
    redraw?.(state.month ? `day-${state.deadline || dateKey(today)}` : "due");
  });
  pick.dataset.focus = "due";
  pick.setAttribute("aria-haspopup", "dialog");
  pick.setAttribute("aria-expanded", String(Boolean(state.month)));
  anchor.append(pick);
  if (picked) {
    const clear = button("due-clear", ICONS.cross, () => {
      Object.assign(state, { deadline: "", time: "", timeShown: false, month: null });
      redraw?.("due");
    });
    clear.setAttribute("aria-label", "No deadline");
    clear.dataset.focus = "clear";
    anchor.append(clear);
  }
  if (state.month) anchor.append(monthPicker(state, sessions, today, redraw));
  due.append(anchor);

  if (picked) {
    if (state.timeShown || state.time) {
      const time = el("input", "draft-time");
      time.type = "time";
      time.value = state.time;
      time.setAttribute("aria-label", "Due by");
      time.dataset.focus = "time";
      time.addEventListener("input", () => (state.time = isTime(time.value) ? time.value : ""));
      const noTime = button("due-clear", ICONS.cross, () => {
        Object.assign(state, { time: "", timeShown: false });
        redraw?.("addtime");
      });
      noTime.setAttribute("aria-label", "End of the day");
      const box = el("span", "draft-time-box");
      box.append(time, noTime);
      due.append(box);
    } else {
      const addTime = button("pill", withIcon(ICONS.clock, "Time"), () => {
        state.timeShown = true;
        redraw?.("time");
      });
      addTime.title = "Due by a time of day, rather than its end";
      addTime.dataset.focus = "addtime";
      due.append(addTime);
    }
    const days = daysBetween(now, picked);
    due.append(el("span", `draft-rel${days < SOON_DAYS ? " is-soon" : ""}`, fromNow(picked, now)));
  } else {
    for (const [index, idea] of suggestions(sessions, now).entries()) {
      const pill = button("pill", idea.label, () => {
        Object.assign(state, { deadline: idea.day, time: idea.time ?? "", timeShown: Boolean(idea.time), month: null });
        redraw?.("due");
      });
      pill.title = idea.title;
      pill.dataset.focus = `idea-${index}`;
      due.append(pill);
    }
  }

  // ---- create
  const foot = el("div", "draft-foot");
  const keys = el("span", "draft-keys");
  keys.append(el("kbd", "", "Enter"), " to create, ", el("kbd", "", "Esc"), " to cancel");
  const cancel = button("button quiet", "Cancel", closeDraft);
  cancel.dataset.focus = "cancel";
  const go = button("button primary", "Create goal", create);
  go.dataset.focus = "create";
  foot.append(keys, cancel, go);

  card.append(head, due, foot);
  card.addEventListener("keydown", (event) => {
    // Its keys are its own: none of them reach the page's shortcuts.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.month) {
        state.month = null;
        redraw?.("due");
      } else closeDraft();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      create();
    }
  });

  if (focusNext) {
    const key = focusNext;
    focusNext = null;
    requestAnimationFrame(() => {
      const target = card.querySelector<HTMLElement>(`[data-focus="${key}"]`) ?? title;
      target.focus();
      if (key === "title") card.scrollIntoView({ block: "nearest" });
    });
  }
  return card;
}

/** "Fri 31 Oct", with the year when it isn't this one. */
function dayText(day: Date, now: Date): string {
  const text = fmtDayMonth(day);
  return day.getFullYear() === now.getFullYear() ? text : `${text} ${day.getFullYear()}`;
}

// --------------------------------------------------------------- month --

let monthFmt: Intl.DateTimeFormat | undefined;

/** Six weeks from the Monday on or before the 1st; days before today can't be picked. */
function monthPicker(state: Draft, sessions: Session[], today: Date, redraw: ((focus?: string) => void) | null): HTMLElement {
  monthFmt ??= new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const first = parseDate(state.month!)!;
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const end = addDays(start, 42);

  const byDay = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.start < start || session.start >= end) continue;
    const key = dateKey(session.start);
    byDay.set(key, [...(byDay.get(key) ?? []), session]);
  }

  const pop = el("div", "minical");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Pick the deadline");

  const step = (by: number, focus: string): void => {
    state.month = dateKey(new Date(first.getFullYear(), first.getMonth() + by, 1));
    redraw?.(focus);
  };
  const head = el("div", "minical-head");
  const prev = button("icon-button", ICONS.back, () => step(-1, "prev"));
  prev.setAttribute("aria-label", "Previous month");
  prev.dataset.focus = "prev";
  prev.disabled = first <= today;
  const next = button("icon-button", ICONS.next, () => step(1, "next"));
  next.setAttribute("aria-label", "Next month");
  next.dataset.focus = "next";
  head.append(prev, el("b", "", monthFmt.format(first)), next);

  const week = el("div", "minical-week");
  const narrow = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  for (let i = 0; i < 7; i++) week.append(el("span", "", narrow.format(addDays(start, i))));

  // One day takes Tab: the one walked to, else the picked one, else today, else the 1st.
  const inMonth = (key: string): boolean => key.slice(0, 7) === state.month!.slice(0, 7);
  const todayKey = dateKey(today);
  const walked = focusNext?.startsWith("day-") ? focusNext.slice(4) : "";
  const tabStop = [walked, state.deadline, todayKey].find(inMonth) ?? dateKey(first < today ? today : first);

  const grid = el("div", "minical-grid");
  grid.setAttribute("role", "grid");
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    const key = dateKey(day);
    const cell = button("minical-day", String(day.getDate()), () => {
      Object.assign(state, { deadline: key, month: null });
      redraw?.("due");
    });
    cell.dataset.focus = `day-${key}`;
    cell.dataset.day = key;
    cell.tabIndex = key === tabStop ? 0 : -1;
    cell.disabled = day < today;
    if (!inMonth(key)) cell.classList.add("is-other");
    if (key === todayKey) cell.classList.add("is-today");
    if (key === state.deadline) cell.setAttribute("aria-selected", "true");
    const there = byDay.get(key);
    let label = fmtFull(day);
    if (there) {
      cell.classList.add("is-session");
      label += `, ${there.map((s) => `${s.type || "session"} ${fmtTime(s.start)}`).join(", ")}`;
      cell.title = there.map((s) => `${labelOf(app.projects.data, s.type)} ${fmtTime(s.start)}`).join("\n");
    }
    cell.setAttribute("aria-label", key === todayKey ? `Today, ${label}` : label);
    grid.append(cell);
  }

  // Arrows walk the days (and across months), Page keys turn the month.
  grid.addEventListener("keydown", (event) => {
    const from = parseDate((event.target as HTMLElement).dataset.day ?? "");
    if (!from) return;
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    const months = { PageUp: -1, PageDown: 1 }[event.key];
    if (by === undefined && months === undefined) return;
    event.preventDefault();
    let to = by !== undefined ? addDays(from, by) : new Date(from.getFullYear(), from.getMonth() + months!, from.getDate());
    if (to < today) to = today;
    state.month = monthKey(to);
    redraw?.(`day-${dateKey(to)}`);
  });

  pop.append(head, week, grid);
  if (byDay.size) {
    const types = [...new Set([...byDay.values()].flat().map((s) => s.type).filter(Boolean))];
    const legend = el("p", "minical-legend");
    legend.append(el("span", "minical-dot"), types.length ? `${types.join(", ")} sessions` : "Sessions");
    pop.append(legend);
  }
  return pop;
}
