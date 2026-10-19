// The editors, each a modal sheet: a todo (or goal), an area with its
// schedule and shortcuts, and a project or course with its shortcuts and its link to the
// calendar its sessions are in.
import { confirmDialog } from "../../utils/confirm";
import { TIME, type Rule } from "../shortcuts/schedule";
import { guessName, toUrl } from "../shortcuts/site";
import { MAX_NOTES, MAX_TITLE, isTime, parseDate, type Todo } from "../todo/store.ts";
import { removeTodos, saveTodo } from "./actions.ts";
import { nearMisses, sessionsOf, summarize, type TypeSummary } from "./match.ts";
import {
  app,
  areaById,
  currentArea,
  currentProject,
  goalsOf,
  isEnded,
  partsOf,
  projectById,
  todoById,
  todosInArea,
} from "./state.ts";
import {
  DEFAULT_LABELS,
  folderFor,
  HUES,
  iconOf,
  labelOf,
  MAX_AREAS,
  MAX_CODE,
  MAX_NAME,
  MAX_RULES,
  MAX_SHORTCUTS,
  newId,
  type Area,
  type Link,
  type Project,
  type Shortcut,
} from "./store.ts";
import {
  areaMark,
  button,
  dot,
  dueText,
  el,
  fmtDayMonth,
  fmtTime,
  hueColor,
  ICONS,
  lengthText,
  loadIcon,
  projectLabel,
  slotLine,
  withIcon,
} from "./ui.ts";

// ----------------------------------------------------------------- sheet --

interface Sheet {
  dialog: HTMLDialogElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  error: HTMLParagraphElement;
  close(): void;
}

function sheet(title: string, wide = false): Sheet {
  const dialog = el("dialog", `sheet${wide ? " is-wide" : ""}`);
  const head = el("header", "sheet-head");
  head.append(el("h2", "", title));
  const close = button("icon-button", ICONS.cross, () => dialog.close());
  close.setAttribute("aria-label", "Close");
  head.append(close);
  const body = el("div", "sheet-body");
  const error = el("p", "sheet-error");
  error.setAttribute("role", "alert");
  const footer = el("div", "sheet-foot");
  dialog.append(head, body, error, footer);
  dialog.addEventListener("close", () => dialog.remove());
  // Keys typed here are the form's, not the page's shortcuts.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.append(dialog);
  return { dialog, body, footer, error, close: () => dialog.close() };
}

function labelled(label: string, control: HTMLElement, className = "field"): HTMLLabelElement {
  const node = el("label", className);
  node.append(el("span", "field-label", label), control);
  return node;
}

function input(value: string, attrs: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const node = el("input");
  node.type = "text";
  node.value = value;
  node.autocomplete = "off";
  Object.assign(node, attrs);
  return node;
}

function select(options: { value: string; label: string; group?: string }[], value: string): HTMLSelectElement {
  const node = el("select");
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const option of options) {
    const item = el("option", "", option.label);
    item.value = option.value;
    if (option.group) {
      let group = groups.get(option.group);
      if (!group) {
        group = el("optgroup");
        group.label = option.group;
        groups.set(option.group, group);
        node.append(group);
      }
      group.append(item);
    } else node.append(item);
  }
  node.value = value;
  return node;
}

function toggle(label: string, checked: boolean, hint = ""): { node: HTMLLabelElement; box: HTMLInputElement } {
  const node = el("label", "switch");
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  node.append(box, el("span", "switch-track"), el("span", "", label));
  if (hint) node.append(el("small", "", hint));
  return { node, box };
}

function swatches(value: number, onPick: (hue: number) => void): HTMLDivElement {
  const row = el("div", "swatches");
  row.setAttribute("role", "radiogroup");
  const hues = HUES.includes(value) ? HUES : [value, ...HUES];
  for (const hue of hues) {
    const swatch = button("swatch", "", () => {
      for (const each of row.children) each.setAttribute("aria-checked", String(each === swatch));
      onPick(hue);
    });
    swatch.style.background = hueColor(hue);
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", String(hue === value));
    swatch.setAttribute("aria-label", `Colour ${hue}`);
    row.append(swatch);
  }
  return row;
}

const actionButton = (label: string, className: string, onClick: () => void): HTMLButtonElement =>
  button(`button ${className}`, label, onClick);

// ------------------------------------------------------------------ todo --

const LENGTHS = [0, 15, 30, 45, 60, 90, 120, 180, 240];

/** An area itself, as a value of the place picker: "area:<id>". */
const AREA = "area:";

/**
 * The open projects, by area, for a place picker; with `areas`, each area
 * itself first ("Private — no project"), for a todo kept straight in it.
 */
function projectOptions(include?: string, areas = false): { value: string; label: string; group: string }[] {
  const out: { value: string; label: string; group: string }[] = [];
  for (const area of app.projects.data.areas) {
    // Named in full: a closed select doesn't show its group.
    if (areas) out.push({ value: AREA + area.id, label: `${area.name} — no project`, group: area.name });
    for (const project of app.projects.data.projects) {
      if (project.area !== area.id) continue;
      if (isEnded(project) && project.id !== include) continue;
      out.push({ value: project.id, label: projectLabel(project), group: area.name });
    }
  }
  return out;
}

/**
 * One line of a property list: an icon and a name on the left, the controls
 * on the right. `clear`, when given, empties the line from an x at its end.
 */
function property(
  icon: string,
  label: string,
  controls: HTMLElement[],
  clear?: { label: string; onClear: () => void },
): { node: HTMLDivElement; mark: HTMLSpanElement; clear?: HTMLButtonElement } {
  const node = el("div", "prop");
  const name = el("span", "prop-name");
  const mark = el("span", "prop-icon");
  mark.innerHTML = icon;
  name.append(mark, el("span", "", label));
  const value = el("div", "prop-value");
  value.append(...controls);
  node.append(name, value);
  // The controls are named by the line they're on.
  for (const control of controls) if (!control.hasAttribute("aria-label")) control.setAttribute("aria-label", label);
  if (!clear) return { node, mark };
  value.classList.add("is-when");
  const x = button("icon-button prop-clear", ICONS.cross, clear.onClear);
  x.setAttribute("aria-label", clear.label);
  x.title = clear.label;
  value.append(x);
  return { node, mark, clear: x };
}

/** Edits a todo, or a goal (no plan, no goal of its own). */
export function editTodo(todo: Todo): void {
  const isGoal = Boolean(todo.goal);
  const s = sheet(isGoal ? "Goal" : "Todo");
  s.dialog.classList.add("is-todo");
  s.dialog.classList.toggle("is-goal", isGoal);

  // The title leads, with its tick, as it does in the lists.
  const title = input(todo.title, { maxLength: MAX_TITLE, placeholder: isGoal ? "What the goal is" : "What to do", className: "title-input" });
  title.setAttribute("aria-label", "Title");
  const top = el("div", "sheet-title");
  const done = { checked: todo.done };
  const tick = button("tick", ICONS.check, () => {
    done.checked = !done.checked;
    showDone();
  });
  const showDone = (): void => {
    top.classList.toggle("is-done", done.checked);
    tick.setAttribute("aria-pressed", String(done.checked));
    tick.title = done.checked ? "Done; mark not done" : "Mark done";
    tick.setAttribute("aria-label", tick.title);
  };
  showDone();
  top.append(tick, title);

  // A goal belongs to a project; any other todo may also sit in an area on its own.
  const place = select(
    [{ value: "", label: isGoal ? "No project" : "Nowhere", group: "" }, ...projectOptions(todo.project, !isGoal)],
    projectById(todo.project) ? todo.project! : !isGoal && areaById(todo.area) ? AREA + todo.area : "",
  );
  /** The project picked, or "" for an area on its own or nowhere. */
  const projectId = (): string => (place.value.startsWith(AREA) ? "" : place.value);
  const goal = select([], "");
  const fillGoals = (): void => {
    const goals = projectId() ? goalsOf(projectId()).filter((each) => !each.done || each.id === todo.parent) : [];
    goal.disabled = !goals.length;
    goal.replaceChildren();
    const none = !projectId() ? "Pick a project first" : goals.length ? "None" : "This project has no goals";
    goal.append(Object.assign(el("option", "", none), { value: "" }));
    for (const each of goals) goal.append(Object.assign(el("option", "", each.title), { value: each.id }));
    goal.value = goals.some((each) => each.id === todo.parent) ? todo.parent! : "";
  };

  const date = input(todo.date ?? "", { type: "date" });
  const time = input(todo.time ?? "", { type: "time" });
  // A length set elsewhere (the Todo app takes any) is offered as it is, so
  // saving doesn't quietly change it.
  const lengths = LENGTHS.includes(todo.minutes ?? 0) ? LENGTHS : [...LENGTHS, todo.minutes!].sort((a, b) => a - b);
  const length = select(
    lengths.map((minutes) => ({ value: String(minutes), label: minutes ? lengthText(minutes) : "No length" })),
    String(todo.minutes ?? 0),
  );
  date.setAttribute("aria-label", "Plan on");
  time.setAttribute("aria-label", "Plan at");
  length.setAttribute("aria-label", "Plan for");
  length.className = "is-length";
  const deadline = input(todo.deadline ?? "", { type: "date" });
  const deadlineTime = input(todo.deadlineTime ?? "", { type: "time" });
  deadline.setAttribute("aria-label", "Due on");
  deadlineTime.setAttribute("aria-label", "Due by");
  const notes = el("textarea", "notes-input");
  notes.value = todo.notes ?? "";
  notes.maxLength = MAX_NOTES;
  notes.rows = 3;
  notes.placeholder = "Add notes";
  notes.setAttribute("aria-label", "Notes");

  const props = el("div", "props");
  const where = property(ICONS.folder, "Project", [place]);
  props.append(where.node);
  const goalLine = property(ICONS.sub, "Goal", [goal]);
  if (!isGoal) props.append(goalLine.node);
  const plan = property(ICONS.calendar, "Plan", [date, time, length], {
    label: "Clear the plan",
    onClear: () => {
      date.value = time.value = "";
      length.value = "0";
      sync();
      date.focus();
    },
  });
  if (!isGoal) props.append(plan.node);
  const due = property(ICONS.flag, "Deadline", [deadline, deadlineTime], {
    label: "Clear the deadline",
    onClear: () => {
      deadline.value = deadlineTime.value = "";
      sync();
      deadline.focus();
    },
  });
  const goalDue = el("p", "prop-hint");
  props.append(due.node, goalDue);

  /** Shows what depends on what: a time needs a day, a length a time. */
  const sync = (): void => {
    for (const each of [date, time, deadline, deadlineTime]) each.classList.toggle("is-empty", !each.value);
    time.disabled = !date.value;
    length.disabled = !date.value || !time.value;
    length.classList.toggle("is-empty", length.value === "0");
    deadlineTime.disabled = !deadline.value;
    // Hidden but kept in place, so the columns don't shift.
    plan.clear!.style.visibility = date.value || time.value ? "" : "hidden";
    due.clear!.style.visibility = deadline.value || deadlineTime.value ? "" : "hidden";
    // The project's colour, or its area's, marks where the todo is.
    const hue = projectById(projectId())?.hue ?? areaById(place.value.slice(AREA.length))?.hue;
    where.mark.replaceChildren(hue === undefined ? el("span", "dot is-none") : dot(hue));
    const parent = !isGoal && goal.value ? todoById(goal.value) : undefined;
    const parentDue = parent ? dueText(parent, new Date()) : "";
    goalDue.textContent = parentDue ? `The goal is due ${parentDue}.` : "";
  };
  fillGoals();
  sync();
  place.addEventListener("change", () => {
    fillGoals();
    sync();
  });
  for (const each of [goal, date, time, length, deadline, deadlineTime]) each.addEventListener("input", sync);

  s.body.append(top, props, notes);

  const save = (): void => {
    const name = title.value.trim();
    if (!name) {
      s.error.textContent = "Give it a title.";
      title.focus();
      return;
    }
    const day = parseDate(date.value) ? date.value : "";
    const at = day && isTime(time.value) ? time.value : "";
    const dueDay = parseDate(deadline.value) ? deadline.value : "";
    const dueAt = dueDay && isTime(deadlineTime.value) ? deadlineTime.value : "";
    const minutes = at ? Number(length.value) : 0;
    const next: Todo = {
      id: todo.id,
      title: name,
      done: done.checked,
      createdAt: todo.createdAt,
      ...(!isGoal && day && { date: day }),
      ...(!isGoal && at && { time: at }),
      ...(!isGoal && minutes && { minutes }),
      ...(dueDay && { deadline: dueDay }),
      ...(dueAt && { deadlineTime: dueAt }),
      ...(notes.value.trim() && { notes: notes.value.trim() }),
      ...(done.checked && { doneAt: todo.doneAt ?? Date.now() }),
      ...(projectId() && { project: projectId() }),
      ...(place.value.startsWith(AREA) && { area: place.value.slice(AREA.length) }),
      ...(isGoal && { goal: true }),
      ...(!isGoal && goal.value && { parent: goal.value }),
    };
    saveTodo(todo, next);
    // A goal moved to another project takes its parts along.
    if (isGoal && projectId() && projectId() !== todo.project) {
      const parts = partsOf(todo).map((part) => part.id);
      const to = projectId();
      app.save(
        app.todos.update((data) => {
          for (const part of data.todos) if (parts.includes(part.id)) part.project = to;
        }),
        "todos",
      );
    }
    s.close();
    app.render();
  };

  const remove = actionButton(withIcon(ICONS.trash, "Delete"), "danger", () => {
    s.close();
    const parts = isGoal ? partsOf(todo).length : 0;
    removeTodos(
      [todo.id],
      isGoal && parts ? `Goal deleted; its ${parts} part${parts === 1 ? "" : "s"} stay as todos.` : "Deleted.",
    );
    app.render();
  });
  s.footer.append(remove, el("span", "spacer"), actionButton("Cancel", "", s.close), actionButton("Save", "primary", save));
  s.dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
      event.preventDefault();
      save();
    }
  });
  s.dialog.showModal();
  title.focus();
}

// ------------------------------------------------------------------ area --

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ruleRow(rule: Rule, onRemove: () => void): { node: HTMLLIElement; read: () => Rule | null } {
  const node = el("li", "rule");
  const days = new Set(rule.days);
  const dayRow = el("div", "days");
  for (const day of WEEK) {
    const pick = button("day-pick", DAY_LETTERS[day]!, () => {
      if (days.has(day)) days.delete(day);
      else days.add(day);
      pick.setAttribute("aria-pressed", String(days.has(day)));
    });
    pick.setAttribute("aria-pressed", String(days.has(day)));
    pick.setAttribute("aria-label", DAY_NAMES[day]!);
    dayRow.append(pick);
  }
  const from = input(rule.from, { type: "time" });
  const to = input(rule.to, { type: "time" });
  from.setAttribute("aria-label", "From");
  to.setAttribute("aria-label", "Until");
  const remove = button("icon-button", ICONS.cross, onRemove);
  remove.setAttribute("aria-label", "Remove this time");
  node.append(dayRow, from, el("span", "dash", "to"), to, remove);
  return {
    node,
    read: () => (days.size && TIME.test(from.value) && TIME.test(to.value) ? { days: [...days].sort(), from: from.value, to: to.value } : null),
  };
}

/** A new area (no `area`), or an existing one's settings. */
const BAD_SITE = "One of the sites isn't an address that can be opened (https or mailto).";

/** An area's or project's sites, a row each; read() is null while one of them isn't an address. */
function shortcutsEditor(given: Shortcut[], about: string): { node: HTMLElement; read: () => Shortcut[] | null } {
  const node = el("section", "group");
  const list = el("ul", "shortcut-edit");
  const rows: { read: () => Shortcut | null | "bad"; node: HTMLLIElement }[] = [];
  const add = (shortcut: Shortcut): void => {
    const row = el("li", "shortcut-row");
    const label = input(shortcut.name, { placeholder: "Name", maxLength: 40 });
    const url = input(shortcut.url, { placeholder: "brightspace.example.edu", inputMode: "url", spellcheck: false });
    const remove = button("icon-button", ICONS.cross, () => {
      rows.splice(rows.findIndex((each) => each.node === row), 1);
      row.remove();
    });
    remove.setAttribute("aria-label", "Remove shortcut");
    row.append(url, label, remove);
    list.append(row);
    rows.push({
      node: row,
      read: () => {
        if (!url.value.trim() && !label.value.trim()) return null;
        const parsed = toUrl(url.value);
        if (!parsed) return "bad";
        return { name: label.value.trim() || guessName(parsed), url: parsed.href };
      },
    });
  };
  for (const shortcut of given) add(shortcut);
  node.append(
    el("h3", "", "Shortcuts"),
    el("p", "hint", about),
    list,
    button("link", "+ Add a site", () => {
      if (rows.length < MAX_SHORTCUTS) add({ name: "", url: "" });
      list.querySelector<HTMLInputElement>("li:last-child input")?.focus();
    }),
  );
  const read = (): Shortcut[] | null => {
    const sites: Shortcut[] = [];
    for (const row of rows) {
      const site = row.read();
      if (site === "bad") return null;
      if (site) sites.push(site);
    }
    return sites;
  };
  return { node, read };
}

export function editArea(area?: Area): void {
  const s = sheet(area ? "Area settings" : "New area");
  let hue = area?.hue ?? HUES[app.projects.data.areas.length % HUES.length]!;
  const name = input(area?.name ?? "", { maxLength: MAX_NAME, placeholder: "Uni, Work, Private…" });

  // The icon: a link to an image, previewed in the tile as it's typed.
  const icon = input(area?.icon ?? "", { type: "url", placeholder: "https://… (optional)" });
  const iconRow = el("div", "icon-field");
  const ABOUT_ICON = "A link to an image, shown in place of the coloured tile.";
  const iconHint = el("p", "hint", ABOUT_ICON);
  let mark = el("span");
  let typing = 0;
  const preview = (): void => {
    const link = iconOf(icon.value);
    const next = areaMark({ name: name.value || "?", hue, icon: link }, "rail-swatch is-big");
    mark.replaceWith(next);
    mark = next;
    if (!icon.value.trim()) iconHint.textContent = ABOUT_ICON;
    else if (!link) iconHint.textContent = "That isn't an https link.";
    else {
      iconHint.textContent = "Loading…";
      void loadIcon(link).then((src) => {
        if (iconOf(icon.value) === link) iconHint.textContent = src ? ABOUT_ICON : "There's no image at that link.";
      });
    }
  };
  icon.addEventListener("input", () => {
    s.error.textContent = "";
    clearTimeout(typing);
    typing = window.setTimeout(preview, 400);
  });
  name.addEventListener("input", preview);
  iconRow.append(mark, icon);
  preview();

  s.body.append(
    labelled("Name", name),
    labelled("Colour", swatches(hue, (next) => ((hue = next), preview())), "field"),
    labelled("Icon", iconRow),
    iconHint,
  );

  const rules = el("ul", "rules");
  const rows: { node: HTMLLIElement; read: () => Rule | null }[] = [];
  const addRule = (rule: Rule): void => {
    const row = ruleRow(rule, () => {
      rows.splice(rows.indexOf(row), 1);
      row.node.remove();
    });
    rows.push(row);
    rules.append(row.node);
  };
  for (const rule of area?.rules ?? []) addRule(rule);
  const group = el("section", "group");
  group.append(
    el("h3", "", "Opens on its own"),
    el("p", "hint", "During these times the app opens on this area. A course's own sessions come first."),
    rules,
    button("link", "+ Add a time", () => {
      if (rows.length < MAX_RULES) addRule({ days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" });
    }),
  );
  s.body.append(group);

  // Its own calendar
  const calendar = calendarSelect("No calendar", area?.calendar ?? "");
  const openDuring = toggle("Open this area during its events", area?.openDuring ?? false, "a course's own sessions still come first");
  const calendarHint = el("p", "hint");
  const syncCalendar = (): void => {
    openDuring.node.hidden = !calendar.value;
    calendarHint.textContent = calendar.value
      ? "Its events show in this area's colour, and new courses here look for their sessions in it."
      : "A calendar for the whole area, such as work meetings or your uni timetable.";
  };
  calendar.addEventListener("change", syncCalendar);
  syncCalendar();
  const calendarGroup = el("section", "group");
  calendarGroup.append(el("h3", "", "Calendar"), calendarHint, labelled("Events from", calendar), openDuring.node);
  s.body.append(calendarGroup);

  const shortcuts = shortcutsEditor(area?.shortcuts ?? [], "Sites for the whole area. On its overview, keys 1 to 9 open them in a new tab.");
  s.body.append(shortcuts.node);

  let saving = false;
  const save = async (): Promise<void> => {
    if (saving) return;
    const label = name.value.trim();
    if (!label) {
      s.error.textContent = "Give the area a name.";
      name.focus();
      return;
    }
    const read = rows.map((row) => row.read());
    if (read.some((rule) => !rule)) {
      s.error.textContent = "Each time needs at least one day, and a start and end.";
      return;
    }
    const sites = shortcuts.read();
    if (!sites) {
      s.error.textContent = BAD_SITE;
      return;
    }
    const link = iconOf(icon.value);
    if (icon.value.trim() && !link) {
      s.error.textContent = "The icon needs an https link.";
      icon.focus();
      return;
    }
    // Usually already loaded by the preview.
    saving = true;
    const loaded = !link || (await loadIcon(link)) !== null;
    saving = false;
    if (!loaded) {
      s.error.textContent = "There's no image at the icon's link.";
      icon.focus();
      return;
    }
    const next: Area = {
      id: area?.id ?? newId(),
      name: label,
      hue,
      ...(link && { icon: link }),
      rules: read as Rule[],
      calendar: calendar.value,
      openDuring: Boolean(calendar.value) && openDuring.box.checked,
      shortcuts: sites,
    };
    if (!area && app.projects.data.areas.length >= MAX_AREAS) {
      s.error.textContent = `That's the most areas there can be (${MAX_AREAS}).`;
      return;
    }
    app.save(
      app.projects.update((data) => {
        const at = data.areas.findIndex((each) => each.id === next.id);
        if (at === -1) data.areas.push(structuredClone(next));
        else data.areas[at] = structuredClone(next);
      }),
      "projects",
    );
    s.close();
    if (!area) app.go({ view: "area", id: next.id }, "list");
    else app.render();
  };

  if (area && canDeleteArea()) {
    s.footer.append(
      actionButton("Delete area", "danger", () => void deleteArea(area, s.close)),
    );
  }
  s.footer.append(el("span", "spacer"), actionButton("Cancel", "", s.close), actionButton(area ? "Save" : "Add area", "primary", () => void save()));
  s.dialog.showModal();
  name.focus();
}

/** Whether an area may go: there's always one left. */
export const canDeleteArea = (): boolean => app.projects.data.areas.length > 1;

/**
 * Asks, then deletes an area and its courses and projects (not their todos
 * or notes). `onConfirmed` runs first, to close the sheet it was asked from.
 */
export async function deleteArea(area: Area, onConfirmed?: () => void): Promise<void> {
  if (!canDeleteArea()) return;
  const count = app.projects.data.projects.filter((p) => p.area === area.id).length;
  const todos = todosInArea(area.id).length;
  const ok = await confirmDialog(
    count
      ? `${area.name} and its ${count} course${count === 1 ? "" : "s"} and projects go. Their ${todos} todo${todos === 1 ? "" : "s"} stay in the Todo app, and notes stay in their folders.`
      : todos
        ? `${area.name} goes. Its ${todos} todo${todos === 1 ? "" : "s"} stay in the Todo app.`
        : `${area.name} goes.`,
    { title: `Delete ${area.name}?`, ok: "Delete", danger: true },
  );
  if (!ok) return;
  onConfirmed?.();
  const wasOpen = currentArea() === area.id;
  app.save(
    app.projects.update((data) => {
      data.areas = data.areas.filter((each) => each.id !== area.id);
      data.projects = data.projects.filter((each) => each.area !== area.id);
    }),
    "projects",
  );
  if (wasOpen) app.go({ view: "today" }, "rail");
  else app.render();
}

// --------------------------------------------------------------- project --

/**
 * A pick of the calendars, with `none` for "" first; one that's gone (hidden
 * in the Calendar, or unsubscribed) stays picked, so saving keeps it.
 */
function calendarSelect(none: string, value: string): HTMLSelectElement {
  const options = [{ value: "", label: none }, ...app.calendars.calendars.map((cal) => ({ value: cal.id, label: cal.name }))];
  const node = select(options, value);
  if (value && !options.some((option) => option.value === value)) {
    node.append(Object.assign(el("option", "", "A calendar that's gone"), { value }));
    node.value = value;
  }
  return node;
}

function slotText(summary: TypeSummary): string {
  const slot = summary.slots[0];
  if (!slot) {
    return summary.count === 1
      ? `${fmtDayMonth(summary.first)} ${fmtTime(summary.first)}`
      : `${summary.count} times, ${fmtDayMonth(summary.first)} – ${fmtDayMonth(summary.last)}`;
  }
  return slotLine(slot);
}

/** A new course or project in `areaId`, or an existing one's settings. */
/**
 * Asks, then deletes a course or project (not its todos or notes).
 * `onConfirmed` runs first, to close the sheet it was asked from.
 */
export async function deleteProject(project: Project, onConfirmed?: () => void): Promise<void> {
  const todos = app.todos.data.todos.filter((todo) => todo.project === project.id).length;
  const ok = await confirmDialog(
    `${todos ? `Its ${todos} todo${todos === 1 ? "" : "s"} stay in the Todo app, without a project. ` : ""}Its notes stay in their folder.`,
    { title: `Delete ${project.name}?`, ok: "Delete", danger: true },
  );
  if (!ok) return;
  onConfirmed?.();
  const wasOpen = currentProject()?.id === project.id;
  app.save(
    app.projects.update((data) => {
      data.projects = data.projects.filter((each) => each.id !== project.id);
    }),
    "projects",
  );
  if (wasOpen) app.go({ view: "area", id: project.area }, "list");
  else app.render();
}

export function editProject(project?: Project, areaId?: string): void {
  const s = sheet(project ? (project.kind === "course" ? "Course settings" : "Project settings") : "New course or project", true);
  const startArea = project?.area ?? areaId ?? app.projects.data.areas[0]?.id ?? "";
  const draft = {
    kind: project?.kind ?? ("course" as Project["kind"]),
    hue: project?.hue ?? areaById(startArea)?.hue ?? HUES[0]!,
    link: structuredClone(
      project?.link ??
        ({ calendar: areaById(startArea)?.calendar ?? "", skip: [], open: true, busy: true, end: true } satisfies Link),
    ),
    labels: { ...app.projects.data.labels },
    ended: project?.ended,
  };

  // Kind
  const kinds = el("div", "segmented");
  kinds.setAttribute("role", "radiogroup");
  const kindButtons = (["course", "project"] as const).map((kind) => {
    const pick = button("segment", kind === "course" ? "Course" : "Project", () => {
      draft.kind = kind;
      for (const each of kindButtons) each.setAttribute("aria-checked", String(each === pick));
      sync();
    });
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(draft.kind === kind));
    return pick;
  });
  kinds.append(...kindButtons);
  s.body.append(kinds);

  const name = input(project?.name ?? "", { maxLength: MAX_NAME, placeholder: "Software Systems" });
  const code = input(project?.code ?? "", { maxLength: MAX_CODE, placeholder: "SOS", className: "mono" });
  const area = select(
    app.projects.data.areas.map((each) => ({ value: each.id, label: each.name })),
    startArea,
  );
  const top = el("div", "field-row");
  const codeField = labelled("Code", code, "field is-code");
  top.append(labelled("Name", name, "field is-grow"), codeField, labelled("Area", area));
  s.body.append(top, labelled("Colour", swatches(draft.hue, (hue) => (draft.hue = hue))));

  // Sessions
  const sessions = el("section", "group");
  const calendar = calendarSelect("All calendars", draft.link.calendar);
  const found = el("div", "found");
  const foundCount = el("span", "found-count");
  const how = el("p", "hint");
  const calendarRow = el("div", "field-row");
  calendarRow.append(labelled("Look in", calendar));
  const head = el("h3", "");
  head.append("Sessions from your calendar", foundCount);
  const open = toggle("Open this course during its sessions", draft.link.open, "like an area's times");
  const busy = toggle("Count sessions as busy when planning", draft.link.busy, "off for ones you skip");
  const end = toggle("Move to Ended after the last session", draft.link.end);
  sessions.append(head, calendarRow, how, found, open.node, busy.node, end.node);
  s.body.append(sessions);

  // Shortcuts
  const shortcuts = shortcutsEditor(project?.shortcuts ?? [], "Sites for this project. On its page, keys 1 to 9 open them in a new tab.");
  s.body.append(shortcuts.node);

  const refresh = (): void => {
    const course = draft.kind === "course";
    codeField.hidden = !course;
    sessions.hidden = !course;
    if (!course) return;
    const want = { code: code.value.trim(), name: name.value.trim() };
    how.replaceChildren(
      "An event belongs to this course when its title or notes mention ",
      ...(want.code ? [el("b", "", want.code)] : []),
      ...(want.code && want.name ? [" or "] : []),
      ...(want.name ? [el("b", "", want.name)] : []),
      ...(!want.code && !want.name ? ["its code or name"] : []),
      " as a whole word.",
    );
    const events = app.calendars.calendars
      .filter((cal) => !calendar.value || cal.id === calendar.value)
      .flatMap((cal) => cal.events);
    const now = Date.now();
    const all = sessionsOf(events, want.code, want.name, new Date(now - 200 * 86_400_000), new Date(now + 400 * 86_400_000));
    const summaries = summarize(all);
    const misses = want.code ? nearMisses(events, want.code, want.name) : [];
    const included = all.filter((session) => !draft.link.skip.includes(session.type)).length;
    foundCount.textContent = summaries.length ? `${included} found` : "";
    found.replaceChildren();
    if (!app.calendars.calendars.length) {
      found.append(el("p", "found-empty", "No calendars yet. Subscribe to or import your uni schedule in the Calendar app, then come back."));
      return;
    }
    if (!summaries.length) {
      found.append(el("p", "found-empty", want.code || want.name ? "Nothing matches yet. Check the code and name, or look in another calendar." : "Type the course's code or name to find its sessions."));
    }
    for (const summary of summaries) {
      const row = el("div", "found-row");
      const box = el("input");
      box.type = "checkbox";
      box.checked = !draft.link.skip.includes(summary.type);
      box.setAttribute("aria-label", `Include ${summary.type || "these"} sessions`);
      box.addEventListener("change", () => {
        draft.link.skip = box.checked
          ? draft.link.skip.filter((type) => type !== summary.type)
          : [...draft.link.skip, summary.type];
        refresh();
      });
      const type = el("span", "type-key", summary.type || "–");
      const label = input(labelOf({ ...app.projects.data, labels: draft.labels }, summary.type), { maxLength: 30, className: "type-label" });
      label.setAttribute("aria-label", `What ${summary.type || "these"} sessions are called`);
      label.disabled = !summary.type;
      label.addEventListener("input", () => {
        const value = label.value.trim();
        if (!summary.type) return;
        if (!value || value === DEFAULT_LABELS[summary.type]) delete draft.labels[summary.type];
        else draft.labels[summary.type] = value;
      });
      row.append(box, type, label, el("span", "found-when", slotText(summary)), el("span", "found-count", `${summary.count}x · until ${fmtDayMonth(summary.last)}`));
      found.append(row);
    }
    for (const miss of misses.slice(0, 3)) {
      const row = el("div", "found-row is-miss");
      const box = el("input");
      box.type = "checkbox";
      box.disabled = true;
      row.append(box, el("span", "type-key", miss.word), el("span", "found-when", `${miss.count} event${miss.count === 1 ? "" : "s"} starting with ${want.code}`), el("span", "found-count", "another code, not included"));
      found.append(row);
    }
  };
  const sync = (): void => {
    refresh();
    endButton.textContent = endLabel();
  };
  code.addEventListener("input", refresh);
  name.addEventListener("input", refresh);
  calendar.addEventListener("change", refresh);
  // A new course looks in its area's calendar until another is picked.
  let areaCalendar = areaById(area.value)?.calendar ?? "";
  area.addEventListener("change", () => {
    const next = areaById(area.value)?.calendar ?? "";
    if (!project && calendar.value === areaCalendar) {
      calendar.value = next;
      refresh();
    }
    areaCalendar = next;
  });

  const endLabel = (): string => {
    const probe = { ...(project ?? ({} as Project)), ended: draft.ended };
    return project && isEnded(probe as Project) ? "Reopen" : "Move to Ended";
  };
  const endButton = actionButton(endLabel(), "", () => {
    const now = project ? isEnded({ ...project, ended: draft.ended }) : false;
    draft.ended = !now;
    endButton.textContent = endLabel();
  });

  const save = (): void => {
    const label = name.value.trim();
    if (!label) {
      s.error.textContent = "Give it a name.";
      name.focus();
      return;
    }
    const sites = shortcuts.read();
    if (!sites) {
      s.error.textContent = BAD_SITE;
      return;
    }
    const course = draft.kind === "course";
    const taken = new Set(app.projects.data.projects.filter((p) => p.id !== project?.id).map((p) => p.folder.toLowerCase()));
    const next: Project = {
      id: project?.id ?? newId(),
      area: area.value,
      kind: draft.kind,
      name: label,
      code: course ? code.value.trim() : "",
      hue: draft.hue,
      shortcuts: sites,
      ...(course && {
        link: { ...draft.link, calendar: calendar.value, open: open.box.checked, busy: busy.box.checked, end: end.box.checked },
      }),
      ...(draft.ended !== undefined && { ended: draft.ended }),
      folder: project?.folder ?? folderFor(course && code.value.trim() ? `${code.value.trim()} ${label}` : label, taken),
    };
    const labels = draft.labels;
    app.save(
      app.projects.update((data) => {
        const at = data.projects.findIndex((each) => each.id === next.id);
        if (at === -1) data.projects.push(structuredClone(next));
        else data.projects[at] = structuredClone(next);
        data.labels = { ...labels };
      }),
      "projects",
    );
    s.close();
    if (!project) app.go({ view: "project", id: next.id }, "page");
    else app.render();
  };

  if (project) {
    s.footer.append(
      actionButton("Delete", "danger", () => void deleteProject(project, s.close)),
      endButton,
    );
  }
  s.footer.append(el("span", "spacer"), actionButton("Cancel", "", s.close), actionButton(project ? "Save" : "Add", "primary", save));
  s.dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT" && (event.target as HTMLInputElement).type !== "checkbox") {
      event.preventDefault();
      save();
    }
  });
  sync();
  s.dialog.showModal();
  name.focus();
}
