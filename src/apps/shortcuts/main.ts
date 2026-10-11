// shortcuts — a speed dial of websites, kept in ~/.config/shortcuts.json.
// Slot n opens with key n; the kernel opens the link in a new browser tab.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir, followAccent } from "../../utils/settings";
import { guessName, hostOf, hueOf, initialOf, toUrl } from "./site";
import shortcutsHTML from "./shortcuts.html?raw";
import "../../ui/theme.css";
import "./shortcuts.css";

interface Shortcut {
  name: string;
  url: string;
}

const SUGGESTIONS: Shortcut[] = [
  { name: "GitHub", url: "https://github.com/" },
  { name: "Gmail", url: "https://mail.google.com/" },
  { name: "YouTube", url: "https://www.youtube.com/" },
  { name: "Wikipedia", url: "https://en.wikipedia.org/" },
  { name: "Maps", url: "https://maps.google.com/" },
  { name: "LinkedIn", url: "https://www.linkedin.com/" },
];

const PENCIL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>`;

let os: AppInterface;
let file = "";
let shortcuts: Shortcut[] = [];
/** The slot whose editor is open, "new" for the add form, null when none is. */
let editing: number | "new" | null = null;
let dragFrom: number | null = null;

export async function main(appOs: AppInterface): Promise<void> {
  os = appOs;
  await followAccent(os);
  const handle = await os.windows.create({ title: "Shortcuts" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = shortcutsHTML;

  file = `${await ensureConfigDir(os)}/shortcuts.json`;
  shortcuts = await load();

  field("dial").addEventListener("keydown", onDialKey);
  document.addEventListener("keydown", onGlobalKey);
  render();
  focusTile(0, false);
}

// ----------------------------------------------------------------- storage --

async function load(): Promise<Shortcut[]> {
  const text = await os.fs.readTextFile(file).catch(() => "[]");
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    // Someone may have edited the file by hand: keep only entries that still open.
    return list.flatMap((item: Partial<Shortcut>) => {
      const url = typeof item?.url === "string" ? toUrl(item.url) : null;
      return url
        ? [
            {
              name:
                typeof item.name === "string" && item.name.trim()
                  ? item.name
                  : guessName(url),
              url: url.href,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

function save(): void {
  os.fs
    .writeTextFile(file, JSON.stringify(shortcuts, null, 2) + "\n")
    .catch((error) => {
      console.error("[shortcuts]", error);
      showStatus("Couldn't save. Try again.", true);
    });
}

// ------------------------------------------------------------------ render --

function render(): void {
  const dial = field("dial");
  dial.replaceChildren(
    ...shortcuts.map((shortcut, i) =>
      editing === i ? editorItem(i) : tileItem(shortcut, i),
    ),
    editing === "new" ? editorItem("new") : addItem(),
  );
  field("empty").hidden = shortcuts.length > 0;
  if (!shortcuts.length) renderSuggestions();
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
  const taken = new Set(shortcuts.map((s) => s.url));
  field("suggestions").replaceChildren(
    ...SUGGESTIONS.filter((s) => !taken.has(s.url)).map((suggestion) => {
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
        shortcuts.push({ ...suggestion });
        save();
        render();
        focusTile(shortcuts.length - 1);
      });
      return chip;
    }),
  );
}

// ------------------------------------------------------------------ editor --

function edit(target: number | "new"): void {
  editing = target;
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
  const li = template.content.firstElementChild!.cloneNode(
    true,
  ) as HTMLLIElement;
  const urlInput = li.querySelector<HTMLInputElement>('[name="url"]')!;
  const nameInput = li.querySelector<HTMLInputElement>('[name="name"]')!;
  const error = li.querySelector<HTMLElement>(".editor-error")!;
  const mono = li.querySelector<HTMLElement>(".mono")!;
  const existing = target === "new" ? null : shortcuts[target];

  li.querySelector('[data-action="save"]')!.textContent = existing
    ? "Save"
    : "Add";
  li.querySelector<HTMLElement>('[data-action="remove"]')!.hidden = !existing;
  if (existing) {
    urlInput.value = existing.url;
    nameInput.value = existing.name;
  }

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

  const back = target === "new" ? shortcuts.length : target;
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
    const shortcut = {
      name: nameInput.value.trim() || guessName(url),
      url: url.href,
    };
    if (target === "new") shortcuts.push(shortcut);
    else shortcuts[target] = shortcut;
    save();
    closeEditor(back);
  };

  li.querySelector('[data-action="save"]')!.addEventListener("click", commit);
  li.querySelector('[data-action="cancel"]')!.addEventListener("click", () =>
    closeEditor(back),
  );
  li.querySelector('[data-action="remove"]')!.addEventListener("click", () =>
    remove(back),
  );
  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  li.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") closeEditor(back);
    else if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      commit();
    }
  });
  return li;
}

// ----------------------------------------------------------------- actions --

function launch(i: number): void {
  const shortcut = shortcuts[i];
  const tile = tiles()[i];
  tile.classList.remove("is-pressed");
  void tile.offsetWidth; // restart the press animation on repeat presses
  tile.classList.add("is-pressed");
  os.shell.openExternal(shortcut.url).catch((error) => {
    console.error("[shortcuts]", error);
    showStatus(`Couldn't open ${shortcut.name}.`, true);
  });
}

function remove(i: number): void {
  const [removed] = shortcuts.splice(i, 1);
  editing = null;
  save();
  render();
  focusTile(Math.min(i, shortcuts.length));
  showStatus(`Removed ${removed.name}`, false, () => {
    shortcuts.splice(i, 0, removed);
    save();
    render();
    focusTile(i);
    showStatus(`Restored ${removed.name}`);
  });
}

function move(from: number, to: number): void {
  if (to < 0 || to >= shortcuts.length || to === from) return;
  const [shortcut] = shortcuts.splice(from, 1);
  shortcuts.splice(to, 0, shortcut);
  save();
  render();
  focusTile(to);
  showStatus(
    to < 9 ? `${shortcut.name} is now ${to + 1}` : `Moved ${shortcut.name}`,
  );
}

function bindDrag(li: HTMLLIElement, i: number): void {
  li.addEventListener("dragstart", (event) => {
    dragFrom = i;
    event.dataTransfer!.effectAllowed = "move";
    event.dataTransfer!.setData("text/uri-list", shortcuts[i].url);
    li.classList.add("is-dragging");
  });
  li.addEventListener("dragend", () => {
    dragFrom = null;
    for (const el of document.querySelectorAll(".is-dragging, .is-drop"))
      el.classList.remove("is-dragging", "is-drop");
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
  const isShortcut = i < shortcuts.length;
  const step = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columns(),
    ArrowDown: columns(),
  }[event.key];

  if (step !== undefined && event.altKey) {
    if (isShortcut)
      move(i, Math.max(0, Math.min(i + step, shortcuts.length - 1)));
  } else if (step !== undefined) {
    const next = i + step;
    if (next >= 0 && next < all.length) focusTile(next);
  } else if (event.key === "Home") focusTile(0);
  else if (event.key === "End") focusTile(all.length - 1);
  else if (isShortcut && (event.key === "e" || event.key === "F2")) edit(i);
  else if (isShortcut && (event.key === "Delete" || event.key === "Backspace"))
    remove(i);
  else return;
  event.preventDefault();
}

function onGlobalKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) return;
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !/^[1-9]$/.test(event.key)
  )
    return;
  const i = Number(event.key) - 1;
  if (!shortcuts[i] || editing !== null) return;
  event.preventDefault();
  focusTile(i);
  launch(i);
}

// ------------------------------------------------------------------ status --

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false, undo?: () => void): void {
  const status = field("status");
  const undoButton = status.querySelector<HTMLButtonElement>(
    '[data-action="undo"]',
  )!;
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
