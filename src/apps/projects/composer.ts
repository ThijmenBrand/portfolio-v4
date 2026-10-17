// The line a todo is added with. On a project's page the todo goes into that
// project; elsewhere it has to be given one: type # and a project's code or
// name (or a goal's title) and pick it. A todo is never left unfiled here.
import { dateKey } from "../todo/store.ts";
import { addTodo } from "./actions.ts";
import { app, currentArea, goalsOf, isEnded, projectById, todoById } from "./state.ts";
import type { Project } from "./store.ts";
import { button, dot, el, ICONS, projectLabel } from "./ui.ts";

export interface ComposerOptions {
  /** The project new todos go into; unset, one has to be picked. */
  project?: string;
  /** The goal new todos are parts of. */
  goal?: string;
  placeholder: string;
  /** Offer "Today" as the plan, pressed to start with. */
  today?: boolean;
  /** Plan new todos on this day (a stored "YYYY-MM-DD"). */
  date?: string;
}

interface Choice {
  project: Project;
  goal?: string;
  label: string;
}

/** Remembered across renders, so a picked project stays picked. */
let chosen: { project: string; goal?: string } | null = null;
let todayPressed = true;

function choices(query: string): Choice[] {
  const q = query.trim().toLocaleLowerCase();
  const area = currentArea();
  const projects = [...app.projects.data.projects]
    .filter((project) => !isEnded(project))
    // The area you are in first, then the areas in their order.
    .sort((a, b) => {
      const rank = (p: Project): number =>
        p.area === area ? -1 : app.projects.data.areas.findIndex((each) => each.id === p.area);
      return rank(a) - rank(b);
    });
  const out: Choice[] = [];
  for (const project of projects) {
    const hit = (text: string): boolean => !q || text.toLocaleLowerCase().includes(q);
    if (hit(project.code) || hit(project.name)) out.push({ project, label: projectLabel(project) });
    for (const goal of goalsOf(project.id)) {
      if (goal.done) continue;
      if (hit(goal.title) || (q && (hit(project.code) || hit(project.name)))) {
        out.push({ project, goal: goal.id, label: goal.title });
      }
    }
  }
  return out.slice(0, 8);
}

export function composer(options: ComposerOptions): HTMLElement {
  const root = el("div", "composer");
  const plus = el("span", "composer-plus");
  plus.innerHTML = ICONS.plus;
  const input = el("input", "composer-input");
  input.type = "text";
  input.placeholder = options.placeholder;
  input.maxLength = 200;
  input.autocomplete = "off";
  input.dataset.composer = "";
  input.setAttribute("aria-label", options.placeholder);
  const chip = el("span", "composer-chip");
  const pill = button("pill", "Today", () => {
    todayPressed = !todayPressed;
    pill.setAttribute("aria-pressed", String(todayPressed));
    input.focus();
  });
  pill.setAttribute("aria-pressed", String(todayPressed));
  pill.hidden = !options.today;
  const picker = el("div", "picker");
  picker.hidden = true;
  picker.setAttribute("role", "listbox");
  const hint = el("p", "composer-hint");
  hint.hidden = true;

  let list: Choice[] = [];
  let active = 0;
  const fixed = Boolean(options.project);

  const drawChip = (): void => {
    chip.replaceChildren();
    const project = projectById(chosen?.project);
    chip.hidden = fixed || !project;
    if (!project || fixed) return;
    const goal = todoById(chosen?.goal);
    chip.append(dot(project.hue), el("span", "", goal ? goal.title : project.code || project.name));
    const clear = button("chip-clear", ICONS.cross, () => {
      chosen = null;
      drawChip();
      input.focus();
    });
    clear.setAttribute("aria-label", "Clear project");
    chip.append(clear);
  };

  const query = (): string | null => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = /(?:^|\s)#([^\s#]*)$/.exec(before);
    return match ? match[1]! : null;
  };

  const drawPicker = (q: string): void => {
    list = choices(q);
    active = Math.min(active, Math.max(0, list.length - 1));
    picker.replaceChildren();
    if (!list.length) {
      picker.append(el("p", "picker-empty", app.projects.data.projects.length ? "No project matches." : "Make a project first, from an area's column."));
    }
    for (const [index, choice] of list.entries()) {
      const item = el("button", `picker-item${index === active ? " is-active" : ""}${choice.goal ? " is-goal" : ""}`);
      item.type = "button";
      item.setAttribute("role", "option");
      item.append(dot(choice.project.hue));
      if (choice.goal) {
        const sub = el("span", "picker-sub");
        sub.innerHTML = ICONS.sub;
        item.append(sub);
      }
      item.append(el("span", "picker-label", choice.label));
      item.append(el("small", "", choice.goal ? "goal" : app.projects.data.areas.find((a) => a.id === choice.project.area)?.name ?? ""));
      // Keep focus in the input, so picking never interrupts typing.
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => pick(choice));
      picker.append(item);
    }
    picker.hidden = false;
  };

  const closePicker = (): void => {
    picker.hidden = true;
    active = 0;
  };

  const pick = (choice: Choice): void => {
    chosen = { project: choice.project.id, ...(choice.goal && { goal: choice.goal }) };
    // Take the "#sos" out of the title.
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at).replace(/(^|\s)#[^\s#]*$/, "$1");
    input.value = (before + input.value.slice(at)).replace(/\s{2,}/g, " ");
    closePicker();
    hint.hidden = true;
    drawChip();
    input.focus();
  };

  const add = (): void => {
    const title = input.value.replace(/(^|\s)#[^\s#]*$/, "$1").trim();
    if (!title) return;
    const project = options.project ?? (projectById(chosen?.project) ? chosen!.project : "");
    if (!project) {
      hint.textContent = "Pick a project for it: type # and its name.";
      hint.hidden = false;
      // A "#sos" that matched nothing is already there: look again for it
      // rather than adding another # on every Enter.
      const tail = /(?:^|\s)#([^\s#]*)$/.exec(input.value);
      if (!tail) input.value = `${input.value.trimEnd()} #`;
      drawPicker(tail ? tail[1]! : "");
      return;
    }
    const goal = options.goal ?? (options.project ? undefined : chosen?.goal);
    const date = options.date ?? (options.today && todayPressed ? dateKey(new Date()) : undefined);
    addTodo({ title, project, ...(goal && todoById(goal) && { parent: goal }), ...(date && { date }) });
    // Off the project's own page it may land somewhere not on screen: say where.
    if (!options.project) {
      const target = projectById(project)!;
      app.status(`Added to ${todoById(goal)?.title ?? (target.code || target.name)}${date ? "" : ", not planned yet"}.`);
    }
    input.value = "";
    hint.hidden = true;
    app.render();
    // The page was drawn again: carry on typing in the new composer.
    requestAnimationFrame(() => {
      const next = document.querySelector<HTMLInputElement>(
        options.goal ? `[data-composer-goal="${options.goal}"]` : "[data-composer]:not([data-composer-goal])",
      );
      next?.focus();
    });
  };

  if (options.goal) input.dataset.composerGoal = options.goal;
  input.addEventListener("input", () => {
    const q = fixed ? null : query();
    if (q === null) closePicker();
    else drawPicker(q);
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (!picker.hidden && list.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        drawPicker(query() ?? "");
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(list[active]!);
        return;
      }
    }
    if (event.key === "Escape") {
      if (!picker.hidden) closePicker();
      else {
        input.value = "";
        input.blur();
      }
      event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  input.addEventListener("blur", () => setTimeout(closePicker, 120));

  drawChip();
  const line = el("div", "composer-line");
  line.append(plus, chip, input, pill);
  root.append(line, picker, hint);
  return root;
}
