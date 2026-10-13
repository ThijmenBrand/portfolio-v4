// shortcuts — a speed dial of websites, kept in ~/.config/shortcuts.json.
// Sites live in spaces (work, uni…), optionally grouped into projects. Each space
// has a schedule; the app shows the space that is on now unless one was picked by
// hand. Slot n of what is shown opens with key n, in a new browser tab.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir, followAccent } from "../../utils/settings";
import { nextChange, ruleSpaceAt, scheduledAt, TIME, type Rule } from "./schedule";
import { guessName, hostOf, hueOf, initialOf, toUrl } from "./site";
import shortcutsHTML from "./shortcuts.html?raw";
import "../../ui/theme.css";
import "./shortcuts.css";

interface Shortcut {
  name: string;
  url: string;
  /** Project id; none means it belongs to the space as a whole. */
  project?: string;
}

interface Project {
  id: string;
  name: string;
}

interface Space {
  id: string;
  name: string;
  rules: Rule[];
  projects: Project[];
  shortcuts: Shortcut[];
  /** The project chip last picked here; none is "All". */
  project?: string;
}

interface Data {
  spaces: Space[];
  defaultSpace: string;
  /** A space picked by hand, kept until the schedule next changes (null: never). */
  override?: { space: string; until: number | null };
}

const SUGGESTIONS: Shortcut[] = [
  { name: "GitHub", url: "https://github.com/" },
  { name: "Gmail", url: "https://mail.google.com/" },
  { name: "YouTube", url: "https://www.youtube.com/" },
  { name: "Wikipedia", url: "https://en.wikipedia.org/" },
  { name: "Maps", url: "https://maps.google.com/" },
  { name: "LinkedIn", url: "https://www.linkedin.com/" },
];

/** Monday first, as Date.getDay() numbers. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const PENCIL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;

let os: AppInterface;
let file = "";
let data: Data;
/** The space on screen. */
let spaceId = "";
let view: "dial" | "settings" = "dial";
/** The shortcut (index into the space's list) whose editor is open, "new" for the add form. */
let editing: number | "new" | null = null;
let dragFrom: number | null = null;
let dragTab: number | null = null;

export async function main(appOs: AppInterface): Promise<void> {
  os = appOs;
  await followAccent(os);
  const handle = await os.windows.create({ title: "Shortcuts" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = shortcutsHTML;

  file = `${await ensureConfigDir(os)}/shortcuts.json`;
  data = await load();
  spaceId = autoSpace();

  field("dial").addEventListener("keydown", onDialKey);
  document.addEventListener("keydown", onGlobalKey);
  action("settings").addEventListener("click", () => (view === "settings" ? closeSettings() : openSettings()));
  field("mode").addEventListener("click", backToSchedule);
  // The schedule moves on while the window is open.
  setInterval(tick, 30_000);
  render();
  focusTile(0, false);
}

// ----------------------------------------------------------------- storage --

const newId = (): string => Math.random().toString(36).slice(2, 10);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function cleanShortcuts(list: unknown, projects: Set<string>): Shortcut[] {
  if (!Array.isArray(list)) return [];
  // Someone may have edited the file by hand: keep only entries that still open.
  return list.flatMap((item: Partial<Shortcut>) => {
    const url = typeof item?.url === "string" ? toUrl(item.url) : null;
    if (!url) return [];
    const project = projects.has(item.project as string) ? item.project : undefined;
    return [{ name: text(item.name) || guessName(url), url: url.href, ...(project && { project }) }];
  });
}

function cleanRules(list: unknown): Rule[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((rule: Partial<Rule>) => {
    const days = Array.isArray(rule?.days) ? rule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    return TIME.test(rule?.from ?? "") && TIME.test(rule?.to ?? "") ? [{ days, from: rule.from!, to: rule.to! }] : [];
  });
}

function cleanSpace(raw: Partial<Space>): Space {
  const projects = Array.isArray(raw?.projects)
    ? raw.projects.flatMap((p: Partial<Project>) => (text(p?.name) ? [{ id: text(p.id) || newId(), name: text(p.name) }] : []))
    : [];
  const ids = new Set(projects.map((p) => p.id));
  return {
    id: text(raw?.id) || newId(),
    name: text(raw?.name) || "Untitled",
    rules: cleanRules(raw?.rules),
    projects,
    shortcuts: cleanShortcuts(raw?.shortcuts, ids),
    ...(ids.has(raw?.project as string) && { project: raw.project }),
  };
}

function newSpace(name: string, shortcuts: Shortcut[] = []): Space {
  return { id: newId(), name, rules: [], projects: [], shortcuts };
}

async function load(): Promise<Data> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(await os.fs.readTextFile(file));
  } catch {
    // No file yet, or not JSON: start over.
  }
  // The file used to be a plain list of shortcuts: that list becomes "General".
  if (Array.isArray(raw)) raw = { spaces: [{ name: "General", shortcuts: raw }] };
  const given = raw as Partial<Data> | null;
  const spaces = Array.isArray(given?.spaces) ? given.spaces.map(cleanSpace) : [];
  if (!spaces.length) spaces.push(newSpace("General"));
  const has = (id: unknown) => spaces.some((s) => s.id === id);
  const override = given?.override;
  return {
    spaces,
    defaultSpace: has(given?.defaultSpace) ? given!.defaultSpace! : spaces[0].id,
    ...(override &&
      has(override.space) && {
        override: { space: override.space, until: typeof override.until === "number" ? override.until : null },
      }),
  };
}

function save(): void {
  os.fs.writeTextFile(file, JSON.stringify(data, null, 2) + "\n").catch((error) => {
    console.error("[shortcuts]", error);
    showStatus("Couldn't save. Try again.", true);
  });
}

// ---------------------------------------------------------------- schedule --

function space(id = spaceId): Space {
  return data.spaces.find((s) => s.id === id) ?? data.spaces[0];
}

function scheduled(): string {
  return scheduledAt(data.spaces, data.defaultSpace, new Date());
}

/** The space that should be on screen: the one picked by hand while that lasts, else the schedule's. */
function autoSpace(): string {
  const override = data.override;
  if (override && (override.until === null || Date.now() < override.until)) return override.space;
  if (override) {
    delete data.override;
    save();
  }
  return scheduled();
}

function pickSpace(id: string): void {
  if (id === scheduled()) delete data.override;
  else data.override = { space: id, until: nextChange(data.spaces, data.defaultSpace, new Date())?.getTime() ?? null };
  save();
  showSpace(id);
}

function showSpace(id: string): void {
  spaceId = id;
  editing = null;
  render();
}

function backToSchedule(): void {
  delete data.override;
  save();
  showSpace(scheduled());
}

/** After the rules or default changed, a hand-picked space lasts until the new next change. */
function scheduleChanged(): void {
  const override = data.override;
  if (override?.space === scheduled()) delete data.override;
  else if (override) override.until = nextChange(data.spaces, data.defaultSpace, new Date())?.getTime() ?? null;
  save();
  renderTabs();
  renderMode();
}

function tick(): void {
  const next = autoSpace();
  renderTabs();
  renderMode();
  // Don't pull the rug from under someone who is editing.
  if (next !== spaceId && view === "dial" && editing === null) showSpace(next);
}

function untilText(until: number | null): string {
  if (until === null) return "Picked by hand";
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString()
    ? `Until ${time}`
    : `Until ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// ------------------------------------------------------------------ render --

function render(): void {
  renderTabs();
  renderMode();
  const inSettings = view === "settings";
  field("settings").hidden = !inSettings;
  field("dial").hidden = inSettings;
  action("settings").setAttribute("aria-pressed", String(inSettings));
  if (inSettings) {
    field("projects").hidden = true;
    field("empty").hidden = true;
    renderSettings();
    return;
  }
  field("settings").replaceChildren();
  renderProjects();
  const shortcuts = space().shortcuts;
  field("dial").replaceChildren(
    ...visible().map(({ shortcut, index }, i) => (editing === index ? editorItem(index) : tileItem(shortcut, i))),
    editing === "new" ? editorItem("new") : addItem(),
  );
  field("empty").hidden = shortcuts.length > 0;
  if (!shortcuts.length) renderSuggestions();
}

function renderTabs(): void {
  const now = scheduled();
  const tabs = data.spaces.map((s, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.draggable = true;
    tab.textContent = s.name;
    if (s.id === spaceId) tab.setAttribute("aria-current", "true");
    if (s.id === now) {
      const dot = document.createElement("span");
      dot.className = "dot";
      tab.append(dot);
      tab.title = `${s.name}: on the schedule now`;
    }
    tab.addEventListener("click", () => {
      if (s.id !== spaceId) pickSpace(s.id);
    });
    // Order is priority when schedules overlap: drag, or Alt+arrows.
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!event.altKey || step === undefined) return;
      event.preventDefault();
      moveSpace(i, i + step);
      field("spaces").querySelectorAll<HTMLElement>(".tab")[i + step]?.focus();
    });
    tab.addEventListener("dragstart", (event) => {
      dragTab = i;
      event.dataTransfer!.effectAllowed = "move";
      tab.classList.add("is-dragging");
    });
    tab.addEventListener("dragend", () => {
      dragTab = null;
      renderTabs();
    });
    tab.addEventListener("dragover", (event) => {
      if (dragTab === null) return;
      event.preventDefault();
      tab.classList.toggle("is-drop", dragTab !== i);
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("is-drop"));
    tab.addEventListener("drop", (event) => {
      event.preventDefault();
      if (dragTab !== null) moveSpace(dragTab, i);
    });
    return tab;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tab tab-add";
  add.textContent = "+";
  add.title = "Add space";
  add.setAttribute("aria-label", "Add space");
  add.addEventListener("click", addSpace);
  field("spaces").replaceChildren(...tabs, add);
}

function renderMode(): void {
  const mode = field("mode") as HTMLButtonElement;
  const override = data.override;
  mode.disabled = !override;
  mode.classList.toggle("is-manual", !!override);
  if (override) {
    mode.innerHTML = `<span></span>${CROSS}`;
    mode.firstElementChild!.textContent = untilText(override.until);
    mode.title = "Back to the schedule";
  } else {
    mode.textContent = "Auto";
    mode.title = "Following the schedule";
  }
}

function renderProjects(): void {
  const s = space();
  const row = field("projects");
  row.hidden = !s.projects.length;
  const chip = (name: string, id: string | undefined): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill";
    button.textContent = name;
    button.setAttribute("aria-pressed", String(s.project === id));
    button.addEventListener("click", () => pickProject(id));
    return button;
  };
  row.replaceChildren(chip("All", undefined), ...s.projects.map((p) => chip(p.name, p.id)));
}

function pickProject(id: string | undefined): void {
  const s = space();
  if (id) s.project = id;
  else delete s.project;
  editing = null;
  save();
  render();
}

/** The shortcuts the dial shows, with their place in the space's list. */
function visible(): { shortcut: Shortcut; index: number }[] {
  const s = space();
  return s.shortcuts
    .map((shortcut, index) => ({ shortcut, index }))
    .filter(({ shortcut }) => !s.project || shortcut.project === s.project);
}

function paintMono(mono: HTMLElement, name: string, url: URL | null): void {
  mono.style.setProperty("--hue", String(url ? hueOf(hostOf(url)) : 250));
  mono.classList.toggle("is-blank", !url);
  mono.querySelector(".mono-letter")!.textContent = url ? initialOf(name) : "+";
}

// ponytail: only /favicon.ico, kept in memory for this run. Read <link rel=icon>
// from the page if too many sites miss, cache to ~/.cache if refetching shows.
const favicons = new Map<string, Promise<string | null>>();

function favicon(host: string): Promise<string | null> {
  let icon = favicons.get(host);
  if (!icon) {
    icon = os.net
      .fetch(`https://${host}/favicon.ico`)
      .then(({ status, contentType, body }) =>
        status === 200 && contentType.startsWith("image/") && body.length
          ? URL.createObjectURL(new Blob([body], { type: contentType }))
          : null,
      )
      .catch(() => null);
    favicons.set(host, icon);
  }
  return icon;
}

function showFavicon(mono: HTMLElement, url: URL): void {
  if (url.protocol !== "https:") return;
  void favicon(url.host).then((src) => {
    if (!src) return;
    const img = Object.assign(document.createElement("img"), {
      className: "mono-icon",
      alt: "",
      src,
    });
    mono.prepend(img);
    mono.classList.add("has-icon");
  });
}

function tileItem(shortcut: Shortcut, i: number): HTMLLIElement {
  const url = new URL(shortcut.url);
  const li = document.createElement("li");
  li.className = "slot";
  li.draggable = true;
  li.innerHTML = `
    <button type="button" class="tile" tabindex="-1">
      <span class="mono"><span class="mono-letter"></span></span>
      <span class="tile-name"></span>
      <span class="tile-host"></span>
    </button>
    <button type="button" class="tile-edit" tabindex="-1">${PENCIL}</button>`;
  const tile = li.querySelector<HTMLButtonElement>(".tile")!;
  const mono = li.querySelector<HTMLElement>(".mono")!;
  paintMono(mono, shortcut.name, url);
  showFavicon(mono, url);
  if (i < 9) {
    const key = document.createElement("kbd");
    key.className = "key";
    key.textContent = String(i + 1);
    mono.append(key);
    tile.setAttribute("aria-keyshortcuts", String(i + 1));
  }
  li.querySelector(".tile-name")!.textContent = shortcut.name;
  li.querySelector(".tile-host")!.textContent = hostOf(url);
  tile.title = `Open ${url.href}`;
  tile.addEventListener("click", () => launch(i));
  tile.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    edit(i);
  });
  const editButton = li.querySelector<HTMLButtonElement>(".tile-edit")!;
  editButton.setAttribute("aria-label", `Edit ${shortcut.name}`);
  editButton.title = "Edit";
  editButton.addEventListener("click", () => edit(i));
  bindDrag(li, i);
  return li;
}

function addItem(): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "slot";
  li.innerHTML = `
    <button type="button" class="tile tile-add" tabindex="-1">
      <span class="mono is-blank" aria-hidden="true"><span class="mono-letter">+</span></span>
      <span class="tile-name">Add shortcut</span>
    </button>`;
  li.querySelector("button")!.addEventListener("click", () => edit("new"));
  return li;
}

function renderSuggestions(): void {
  const s = space();
  const taken = new Set(s.shortcuts.map((shortcut) => shortcut.url));
  field("suggestions").replaceChildren(
    ...SUGGESTIONS.filter((suggestion) => !taken.has(suggestion.url)).map((suggestion) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.innerHTML = `<span class="mono mono-sm" aria-hidden="true"><span class="mono-letter"></span></span><span class="chip-name"></span>`;
      const mono = chip.querySelector<HTMLElement>(".mono")!;
      paintMono(mono, suggestion.name, new URL(suggestion.url));
      showFavicon(mono, new URL(suggestion.url));
      chip.querySelector(".chip-name")!.textContent = suggestion.name;
      chip.setAttribute("aria-label", `Add ${suggestion.name}`);
      chip.addEventListener("click", () => {
        s.shortcuts.push({ ...suggestion, ...(s.project && { project: s.project }) });
        save();
        render();
        focusTile(visible().length - 1);
      });
      return chip;
    }),
  );
}

// ------------------------------------------------------------------ editor --

/** Open the editor for the i-th tile on the dial, or the add form. */
function edit(target: number | "new"): void {
  editing = target === "new" ? target : visible()[target].index;
  render();
  field("dial").querySelector<HTMLInputElement>(".editor input")!.focus();
}

function closeEditor(focus: number): void {
  editing = null;
  render();
  focusTile(focus);
}

function editorItem(target: number | "new"): HTMLLIElement {
  const template = document.querySelector<HTMLTemplateElement>("#editor")!;
  const li = template.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const urlInput = li.querySelector<HTMLInputElement>('[name="url"]')!;
  const nameInput = li.querySelector<HTMLInputElement>('[name="name"]')!;
  const projectSelect = li.querySelector<HTMLSelectElement>('[name="project"]')!;
  const error = li.querySelector<HTMLElement>(".editor-error")!;
  const mono = li.querySelector<HTMLElement>(".mono")!;
  const s = space();
  const existing = target === "new" ? null : s.shortcuts[target];

  li.querySelector('[data-action="save"]')!.textContent = existing ? "Save" : "Add";
  li.querySelector<HTMLElement>('[data-action="remove"]')!.hidden = !existing;
  if (existing) {
    urlInput.value = existing.url;
    nameInput.value = existing.name;
  }

  li.querySelector<HTMLElement>('[data-field="project-field"]')!.hidden = !s.projects.length;
  projectSelect.replaceChildren(
    new Option(`None (all of ${s.name})`, ""),
    ...s.projects.map((p) => new Option(p.name, p.id)),
  );
  projectSelect.value = (existing ? existing.project : s.project) ?? "";

  // The tile-to-be follows what is typed: letter from the name, colour from the site.
  const preview = (): void => {
    const url = toUrl(urlInput.value);
    nameInput.placeholder = url ? guessName(url) : "Name";
    paintMono(mono, nameInput.value.trim() || nameInput.placeholder, url);
  };
  preview();
  urlInput.addEventListener("input", () => {
    error.textContent = "";
    urlInput.removeAttribute("aria-invalid");
    preview();
  });
  nameInput.addEventListener("input", preview);

  const back = target === "new" ? visible().length : visible().findIndex((v) => v.index === target);
  const commit = (): void => {
    const url = toUrl(urlInput.value);
    if (!url) {
      error.textContent = urlInput.value.trim()
        ? "That address can't be opened. Use a web address like github.com."
        : "Enter a web address, like github.com.";
      urlInput.setAttribute("aria-invalid", "true");
      urlInput.focus();
      return;
    }
    const project = projectSelect.value;
    const shortcut: Shortcut = {
      name: nameInput.value.trim() || guessName(url),
      url: url.href,
      ...(project && { project }),
    };
    if (target === "new") s.shortcuts.push(shortcut);
    else s.shortcuts[target] = shortcut;
    save();
    closeEditor(back);
    // Saved into another project than the one on screen: say where it went.
    if (s.project && project !== s.project)
      showStatus(`${shortcut.name} is in ${s.projects.find((p) => p.id === project)?.name ?? "All"}`);
  };

  li.querySelector('[data-action="save"]')!.addEventListener("click", commit);
  li.querySelector('[data-action="cancel"]')!.addEventListener("click", () => closeEditor(back));
  li.querySelector('[data-action="remove"]')!.addEventListener("click", () => remove(back));
  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  li.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeEditor(back);
    else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      commit();
    }
  });
  return li;
}

// ----------------------------------------------------------------- actions --

function launch(i: number): void {
  const shortcut = visible()[i].shortcut;
  const tile = tiles()[i];
  tile.classList.remove("is-pressed");
  void tile.offsetWidth; // restart the press animation on repeat presses
  tile.classList.add("is-pressed");
  os.shell.openExternal(shortcut.url).catch((error) => {
    console.error("[shortcuts]", error);
    showStatus(`Couldn't open ${shortcut.name}.`, true);
  });
}

/** Remove the i-th tile on the dial. */
function remove(i: number): void {
  const s = space();
  const index = visible()[i].index;
  const [removed] = s.shortcuts.splice(index, 1);
  editing = null;
  save();
  render();
  focusTile(Math.min(i, visible().length));
  showStatus(`Removed ${removed.name}`, false, () => {
    s.shortcuts.splice(index, 0, removed);
    save();
    render();
    focusTile(i);
    showStatus(`Restored ${removed.name}`);
  });
}

/** Move the from-th tile on the dial to where the to-th one is. */
function move(from: number, to: number): void {
  const shown = visible();
  if (to < 0 || to >= shown.length || to === from) return;
  const list = space().shortcuts;
  const [shortcut] = list.splice(shown[from].index, 1);
  list.splice(shown[to].index, 0, shortcut);
  save();
  render();
  focusTile(to);
  showStatus(to < 9 ? `${shortcut.name} is now ${to + 1}` : `Moved ${shortcut.name}`);
}

function bindDrag(li: HTMLLIElement, i: number): void {
  li.addEventListener("dragstart", (event) => {
    dragFrom = i;
    event.dataTransfer!.effectAllowed = "move";
    event.dataTransfer!.setData("text/uri-list", visible()[i].shortcut.url);
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => {
    dragFrom = null;
    for (const el of document.querySelectorAll(".is-dragging, .is-drop")) el.classList.remove("is-dragging", "is-drop");
  });
  li.addEventListener("dragover", (event) => {
    if (dragFrom === null) return;
    event.preventDefault();
    li.classList.toggle("is-drop", dragFrom !== i);
  });
  li.addEventListener("dragleave", () => li.classList.remove("is-drop"));
  li.addEventListener("drop", (event) => {
    event.preventDefault();
    if (dragFrom !== null) move(dragFrom, i);
  });
}

function moveSpace(from: number, to: number): void {
  if (to < 0 || to >= data.spaces.length || to === from) return;
  const [moved] = data.spaces.splice(from, 1);
  data.spaces.splice(to, 0, moved);
  scheduleChanged();
  if (view === "settings") renderWeek();
}

function addSpace(): void {
  const s = newSpace("New space");
  data.spaces.push(s);
  save();
  spaceId = s.id;
  openSettings();
  field("settings").querySelector<HTMLInputElement>('[name="space-name"]')!.select();
}

function deleteSpace(): void {
  const s = space();
  const index = data.spaces.indexOf(s);
  const wasDefault = data.defaultSpace === s.id;
  const override = data.override;
  data.spaces.splice(index, 1);
  if (wasDefault) data.defaultSpace = data.spaces[0].id;
  if (override?.space === s.id) delete data.override;
  save();
  view = "dial";
  showSpace(autoSpace());
  showStatus(`Deleted ${s.name}`, false, () => {
    data.spaces.splice(index, 0, s);
    if (wasDefault) data.defaultSpace = s.id;
    if (override?.space === s.id) data.override = override;
    save();
    showSpace(s.id);
    showStatus(`Restored ${s.name}`);
  });
}

// ---------------------------------------------------------------- settings --

function openSettings(): void {
  view = "settings";
  editing = null;
  render();
  field("settings").querySelector<HTMLElement>("input")?.focus();
}

function closeSettings(): void {
  view = "dial";
  // Back on the dial, the schedule decides again.
  showSpace(autoSpace());
  focusTile(0);
}

function renderSettings(): void {
  const s = space();
  const root = field("settings");
  root.replaceChildren(document.querySelector<HTMLTemplateElement>("#settings")!.content.cloneNode(true));

  const name = root.querySelector<HTMLInputElement>('[name="space-name"]')!;
  name.value = s.name;
  name.addEventListener("input", () => {
    s.name = name.value.trim() || "Untitled";
    renderTabs();
  });
  name.addEventListener("change", () => {
    name.value = s.name;
    save();
  });

  renderProjectList();
  root.querySelector('[data-action="add-project"]')!.addEventListener("click", () => {
    s.projects.push({ id: newId(), name: "New project" });
    save();
    renderProjectList();
    root.querySelector<HTMLInputElement>('[data-field="project-list"] li:last-child input')!.select();
  });

  renderRules();
  root.querySelector('[data-action="add-rule"]')!.addEventListener("click", () => {
    s.rules.push({ days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" });
    scheduleChanged();
    renderRules();
    root.querySelector<HTMLElement>('[data-field="rules"] li:last-child button')!.focus();
  });

  const fallback = root.querySelector<HTMLSelectElement>('[name="default-space"]')!;
  fallback.replaceChildren(...data.spaces.map((space) => new Option(space.name, space.id)));
  fallback.value = data.defaultSpace;
  fallback.addEventListener("change", () => {
    data.defaultSpace = fallback.value;
    scheduleChanged();
    renderWeek();
  });

  const remove = root.querySelector<HTMLButtonElement>('[data-action="delete-space"]')!;
  remove.disabled = data.spaces.length === 1;
  remove.title = remove.disabled ? "There has to be one space" : "";
  remove.addEventListener("click", deleteSpace);
  root.querySelector('[data-action="done"]')!.addEventListener("click", closeSettings);
  root.onkeydown = (event) => {
    if (event.key === "Escape") closeSettings();
  };
}

function renderProjectList(): void {
  const s = space();
  field("project-list").replaceChildren(
    ...s.projects.map((project) => {
      const li = document.createElement("li");
      li.className = "row-item";
      li.innerHTML = `<input type="text" maxlength="30" autocomplete="off" /><button type="button" class="icon-button">${CROSS}</button>`;
      const input = li.querySelector("input")!;
      input.value = project.name;
      input.setAttribute("aria-label", "Project name");
      input.addEventListener("change", () => {
        project.name = input.value.trim() || project.name;
        input.value = project.name;
        save();
      });
      const button = li.querySelector("button")!;
      button.setAttribute("aria-label", `Remove ${project.name}`);
      button.title = "Remove project";
      button.addEventListener("click", () => {
        // Its shortcuts stay, as shortcuts of the whole space.
        s.projects = s.projects.filter((p) => p !== project);
        for (const shortcut of s.shortcuts) if (shortcut.project === project.id) delete shortcut.project;
        if (s.project === project.id) delete s.project;
        save();
        renderProjectList();
        showStatus(`Removed ${project.name}; its sites are in All`);
      });
      return li;
    }),
  );
}

function renderRules(): void {
  const s = space();
  const template = document.querySelector<HTMLTemplateElement>("#rule")!;
  field("rules").replaceChildren(
    ...s.rules.map((rule) => {
      const li = template.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
      const from = li.querySelector<HTMLInputElement>('[name="from"]')!;
      const to = li.querySelector<HTMLInputElement>('[name="to"]')!;
      const allDay = li.querySelector<HTMLInputElement>('[name="all-day"]')!;

      li.querySelector(".days")!.replaceChildren(
        ...WEEK.map((day) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "day";
          button.textContent = DAY_NAMES[day][0];
          button.setAttribute("aria-label", DAY_NAMES[day]);
          button.setAttribute("aria-pressed", String(rule.days.includes(day)));
          button.addEventListener("click", () => {
            rule.days = rule.days.includes(day) ? rule.days.filter((d) => d !== day) : [...rule.days, day];
            button.setAttribute("aria-pressed", String(rule.days.includes(day)));
            changed();
          });
          return button;
        }),
      );

      const paint = (): void => {
        from.value = rule.from;
        to.value = rule.to;
        allDay.checked = rule.from === rule.to;
        from.disabled = to.disabled = allDay.checked;
      };
      const changed = (): void => {
        scheduleChanged();
        renderWeek();
      };
      paint();
      for (const input of [from, to])
        input.addEventListener("change", () => {
          if (!TIME.test(input.value)) return paint();
          rule[input.name as "from" | "to"] = input.value;
          // Equal times mean all day; nudge rather than flip the checkbox under them.
          if (rule.from === rule.to) rule.to = rule.from === "23:59" ? "00:00" : "23:59";
          paint();
          changed();
        });
      allDay.addEventListener("change", () => {
        Object.assign(rule, allDay.checked ? { from: "00:00", to: "00:00" } : { from: "09:00", to: "17:00" });
        paint();
        changed();
      });
      li.querySelector('[data-action="remove-rule"]')!.addEventListener("click", () => {
        s.rules = s.rules.filter((r) => r !== rule);
        renderRules();
        changed();
      });
      return li;
    }),
  );
  renderWeek();
}

/** Who is on when, over a week in half-hour steps; faded where only the default applies. */
function renderWeek(): void {
  const week = field("week");
  if (!week) return;
  const STEP = 30;
  const name = (id: string): string => space(id).name;
  const time = (minute: number): string =>
    `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const rows = WEEK.flatMap((day) => {
    const label = document.createElement("span");
    label.className = "week-day";
    label.textContent = DAY_NAMES[day].slice(0, 3);
    const bar = document.createElement("div");
    bar.className = "week-bar";
    let start = 0;
    for (let minute = STEP; minute <= 24 * 60; minute += STEP) {
      const at = ruleSpaceAt(data.spaces, day, start);
      if (minute < 24 * 60 && ruleSpaceAt(data.spaces, day, minute) === at) continue;
      const id = at ?? data.defaultSpace;
      const run = document.createElement("span");
      run.style.flexGrow = String(minute - start);
      run.style.setProperty("--hue", String(hueOf(id)));
      run.classList.toggle("is-default", !at);
      run.title = `${name(id)}, ${time(start)}–${time(minute)}${at ? "" : " (default)"}`;
      bar.append(run);
      start = minute;
    }
    return [label, bar];
  });
  const legend = document.createElement("p");
  legend.className = "week-legend";
  legend.append(
    ...data.spaces.map((s) => {
      const item = document.createElement("span");
      item.style.setProperty("--hue", String(hueOf(s.id)));
      item.textContent = s.name;
      return item;
    }),
  );
  const faded = document.createElement("span");
  faded.className = "is-default";
  faded.textContent = "default";
  legend.append(faded);
  week.replaceChildren(...rows, legend);
}

// ---------------------------------------------------------------- keyboard --

/** Every focusable tile, the add tile last. One tab stop: roving tabindex. */
function tiles(): HTMLButtonElement[] {
  return [...field("dial").querySelectorAll<HTMLButtonElement>(".tile")];
}

function focusTile(i: number, focus = true): void {
  const all = tiles();
  const target = all[Math.max(0, Math.min(i, all.length - 1))];
  for (const tile of all) tile.tabIndex = tile === target ? 0 : -1;
  if (focus) target?.focus();
}

function columns(): number {
  return getComputedStyle(field("dial")).gridTemplateColumns.split(" ").length;
}

function onDialKey(event: KeyboardEvent): void {
  const all = tiles();
  const i = all.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const count = visible().length;
  const isShortcut = i < count;
  const step = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columns(),
    ArrowDown: columns(),
  }[event.key];

  if (step !== undefined && event.altKey) {
    if (isShortcut) move(i, Math.max(0, Math.min(i + step, count - 1)));
  } else if (step !== undefined) {
    const next = i + step;
    if (next >= 0 && next < all.length) focusTile(next);
  } else if (event.key === "Home") focusTile(0);
  else if (event.key === "End") focusTile(all.length - 1);
  else if (isShortcut && (event.key === "e" || event.key === "F2")) edit(i);
  else if (isShortcut && (event.key === "Delete" || event.key === "Backspace")) remove(i);
  else return;
  event.preventDefault();
}

function onGlobalKey(event: KeyboardEvent): void {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (view !== "dial" || editing !== null || event.altKey || event.ctrlKey || event.metaKey) return;
  const s = space();
  if (/^[1-9]$/.test(event.key)) {
    const i = Number(event.key) - 1;
    if (i >= visible().length) return;
    focusTile(i);
    launch(i);
  } else if ((event.key === "[" || event.key === "]") && s.projects.length) {
    const ids = [undefined, ...s.projects.map((p) => p.id)];
    const at = ids.indexOf(s.project);
    pickProject(ids[(at + (event.key === "]" ? 1 : ids.length - 1)) % ids.length]);
    focusTile(0);
  } else if ((event.key === "{" || event.key === "}") && data.spaces.length > 1) {
    const at = data.spaces.indexOf(s);
    const n = data.spaces.length;
    pickSpace(data.spaces[(at + (event.key === "}" ? 1 : n - 1)) % n].id);
    focusTile(0);
  } else return;
  event.preventDefault();
}

// ------------------------------------------------------------------ status --

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false, undo?: () => void): void {
  const status = field("status");
  const undoButton = status.querySelector<HTMLButtonElement>('[data-action="undo"]')!;
  field("status-text").textContent = text;
  status.classList.toggle("is-error", isError);
  status.classList.add("is-shown");
  undoButton.hidden = !undo;
  undoButton.onclick = undo
    ? () => {
        clearTimeout(statusTimer);
        status.classList.remove("is-shown");
        undoButton.hidden = true;
        undo();
      }
    : null;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => {
      status.classList.remove("is-shown");
      undoButton.hidden = true;
    },
    undo ? 6000 : isError ? 4000 : 1600,
  );
}

function field(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
}

function action(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-action="${name}"]`)!;
}
