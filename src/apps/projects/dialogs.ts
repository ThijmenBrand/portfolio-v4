// The editors, each a modal sheet: a todo (or goal), an area and its
// schedule, and a project or course with its shortcuts and its link to the
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
  todosInArea,
} from "./state.ts";
import {
  DEFAULT_LABELS,
  folderFor,
  HUES,
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
import { button, el, fmtDayMonth, fmtTime, hueColor, ICONS, projectLabel, slotLine } from "./ui.ts";

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

/** The open projects, by area, for a project picker. */
function projectOptions(include?: string): { value: string; label: string; group: string }[] {
  const out: { value: string; label: string; group: string }[] = [];
  for (const area of app.projects.data.areas) {
    for (const project of app.projects.data.projects) {
      if (project.area !== area.id) continue;
      if (isEnded(project) && project.id !== include) continue;
      out.push({ value: project.id, label: projectLabel(project), group: area.name });
    }
  }
  return out;
}

/** Edits a todo, or a goal (no plan, no goal of its own). */
export function editTodo(todo: Todo): void {
  const isGoal = Boolean(todo.goal);
  const s = sheet(isGoal ? "Goal" : "Todo");

  const title = input(todo.title, { maxLength: MAX_TITLE });
  const project = select(
    [{ value: "", label: "No project", group: "" }, ...projectOptions(todo.project)],
    projectById(todo.project) ? todo.project! : "",
  );
  const goal = select([], "");
  const fillGoals = (): void => {
    const goals = project.value ? goalsOf(project.value).filter((each) => !each.done || each.id === todo.parent) : [];
    goal.replaceChildren();
    goal.append(Object.assign(el("option", "", "None"), { value: "" }));
    for (const each of goals) goal.append(Object.assign(el("option", "", each.title), { value: each.id }));
    goal.value = goals.some((each) => each.id === todo.parent) ? todo.parent! : "";
  };
  fillGoals();
  project.addEventListener("change", fillGoals);

  const date = input(todo.date ?? "", { type: "date" });
  const time = input(todo.time ?? "", { type: "time" });
  // A length set elsewhere (the Todo app takes any) is offered as it is, so
  // saving doesn't quietly change it.
  const lengths = LENGTHS.includes(todo.minutes ?? 0) ? LENGTHS : [...LENGTHS, todo.minutes!].sort((a, b) => a - b);
  const length = select(
    lengths.map((minutes) => ({ value: String(minutes), label: minutes ? `${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}` : "No length" })),
    String(todo.minutes ?? 0),
  );
  const deadline = input(todo.deadline ?? "", { type: "date" });
  const deadlineTime = input(todo.deadlineTime ?? "", { type: "time" });
  const notes = el("textarea");
  notes.value = todo.notes ?? "";
  notes.maxLength = MAX_NOTES;
  notes.rows = 4;
  const done = toggle("Done", todo.done);

  s.body.append(labelled("Title", title));
  const where = el("div", "field-row");
  where.append(labelled("Project", project));
  if (!isGoal) where.append(labelled("Part of goal", goal));
  s.body.append(where);
  if (!isGoal) {
    const plan = el("div", "field-row");
    plan.append(labelled("Do on", date), labelled("At", time), labelled("For", length));
    s.body.append(plan);
  }
  const due = el("div", "field-row");
  due.append(labelled("Due", deadline), labelled("By", deadlineTime));
  s.body.append(due);
  s.body.append(labelled("Notes", notes), done.node);

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
      done: done.box.checked,
      createdAt: todo.createdAt,
      ...(!isGoal && day && { date: day }),
      ...(!isGoal && at && { time: at }),
      ...(!isGoal && minutes && { minutes }),
      ...(dueDay && { deadline: dueDay }),
      ...(dueAt && { deadlineTime: dueAt }),
      ...(notes.value.trim() && { notes: notes.value.trim() }),
      ...(done.box.checked && { doneAt: todo.doneAt ?? Date.now() }),
      ...(project.value && { project: project.value }),
      ...(isGoal && { goal: true }),
      ...(!isGoal && goal.value && { parent: goal.value }),
    };
    saveTodo(todo, next);
    // A goal moved to another project takes its parts along.
    if (isGoal && project.value && project.value !== todo.project) {
      const parts = partsOf(todo).map((part) => part.id);
      const to = project.value;
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

  const remove = actionButton("Delete", "danger", () => {
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
export function editArea(area?: Area): void {
  const s = sheet(area ? "Area settings" : "New area");
  let hue = area?.hue ?? HUES[app.projects.data.areas.length % HUES.length]!;
  const name = input(area?.name ?? "", { maxLength: MAX_NAME, placeholder: "Uni, Work, Private…" });
  s.body.append(labelled("Name", name), labelled("Colour", swatches(hue, (next) => (hue = next)), "field"));

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

  const save = (): void => {
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
    const next: Area = { id: area?.id ?? newId(), name: label, hue, rules: read as Rule[] };
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
  s.footer.append(el("span", "spacer"), actionButton("Cancel", "", s.close), actionButton(area ? "Save" : "Add area", "primary", save));
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

/** The calendars a course can be linked to. */
function calendarOptions(): { value: string; label: string }[] {
  return [
    { value: "", label: "All calendars" },
    ...app.calendars.calendars.map((cal) => ({ value: cal.id, label: cal.name })),
  ];
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
  const draft = {
    kind: project?.kind ?? ("course" as Project["kind"]),
    hue: project?.hue ?? areaById(areaId ?? project?.area)?.hue ?? HUES[0]!,
    link: structuredClone(project?.link ?? ({ calendar: "", skip: [], open: true, busy: true, end: true } satisfies Link)),
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
    project?.area ?? areaId ?? app.projects.data.areas[0]?.id ?? "",
  );
  const top = el("div", "field-row");
  const codeField = labelled("Code", code, "field is-code");
  top.append(labelled("Name", name, "field is-grow"), codeField, labelled("Area", area));
  s.body.append(top, labelled("Colour", swatches(draft.hue, (hue) => (draft.hue = hue))));

  // Sessions
  const sessions = el("section", "group");
  const calendar = select(calendarOptions(), draft.link.calendar);
  if (draft.link.calendar && !calendarOptions().some((option) => option.value === draft.link.calendar)) {
    calendar.append(Object.assign(el("option", "", "A calendar that's gone"), { value: draft.link.calendar }));
    calendar.value = draft.link.calendar;
  }
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
  const shortcuts = el("section", "group");
  const list = el("ul", "shortcut-edit");
  const shortcutRows: { read: () => Shortcut | null | "bad"; node: HTMLLIElement }[] = [];
  const addShortcut = (shortcut: Shortcut): void => {
    const node = el("li", "shortcut-row");
    const label = input(shortcut.name, { placeholder: "Name", maxLength: 40 });
    const url = input(shortcut.url, { placeholder: "brightspace.example.edu", inputMode: "url", spellcheck: false });
    const remove = button("icon-button", ICONS.cross, () => {
      shortcutRows.splice(shortcutRows.findIndex((row) => row.node === node), 1);
      node.remove();
    });
    remove.setAttribute("aria-label", "Remove shortcut");
    node.append(url, label, remove);
    list.append(node);
    shortcutRows.push({
      node,
      read: () => {
        if (!url.value.trim() && !label.value.trim()) return null;
        const parsed = toUrl(url.value);
        if (!parsed) return "bad";
        return { name: label.value.trim() || guessName(parsed), url: parsed.href };
      },
    });
  };
  for (const shortcut of project?.shortcuts ?? []) addShortcut(shortcut);
  shortcuts.append(
    el("h3", "", "Shortcuts"),
    el("p", "hint", "Sites for this project. On its page, keys 1 to 9 open them in a new tab."),
    list,
    button("link", "+ Add a site", () => {
      if (shortcutRows.length < MAX_SHORTCUTS) addShortcut({ name: "", url: "" });
      list.querySelector<HTMLInputElement>("li:last-child input")?.focus();
    }),
  );
  s.body.append(shortcuts);

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
    const sites: Shortcut[] = [];
    for (const row of shortcutRows) {
      const read = row.read();
      if (read === "bad") {
        s.error.textContent = "One of the sites isn't an address that can be opened (https or mailto).";
        return;
      }
      if (read) sites.push(read);
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
