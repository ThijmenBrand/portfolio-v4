// files — browse and manage the VFS: places, icon/list views, rename, copy,
// move, delete, upload, Quick Look. `files [path]` opens at path.
import type { AppInterface } from "../../kernel/syscalls/api";
import type { DirEntry } from "../../kernel/fs/types";
import type { WindowHandle } from "../../kernel/windows/types";
import { permits, W } from "../../kernel/fs/perm";
import { errorCode } from "../../bin/lib/input";
import { registry } from "../registry";
import { followAccent, loadSettings } from "../../utils/settings";
import { formatSize, freeName } from "./names";
import { PLACES } from "../../utils/places";
import { defaultAppFor, extOf, FILE_SVG, FOLDER_SVG, IMAGE_TYPES, readShortcut } from "../../utils/filetypes";
import filesHTML from "./files.html?raw";
import "../../ui/theme.css";
import "./files.css";

interface Item extends DirEntry {
  path: string;
}

type SortKey = "name" | "modifiedAt" | "size" | "kind";

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_THUMB = 8 * 1024 * 1024;
const MAX_PEEK_TEXT = 64 * 1024;
const IS_MAC = navigator.userAgent.includes("Mac");
const DRAG_TYPE = "application/x-vfs-paths";

/** Extension -> [kind, label color]. Colors match Code's explorer badges. */
const TYPES: Record<string, [string, string]> = {
  ts: ["TypeScript", "#4d9fff"],
  tsx: ["TypeScript", "#4d9fff"],
  js: ["JavaScript", "#e8c547"],
  mjs: ["JavaScript", "#e8c547"],
  json: ["JSON", "#e2b95f"],
  css: ["CSS", "#c678dd"],
  html: ["HTML", "#e8744f"],
  md: ["Markdown", "#5ab0c6"],
  py: ["Python", "#6cd39a"],
  sh: ["Shell script", "#6cd39a"],
  txt: ["Plain text", "#9b9ba6"],
  pdf: ["PDF document", "#ff7676"],
};

const ERRORS: Record<string, string> = {
  EACCES: "You don't have permission to do that here.",
  EPERM: "You don't have permission to do that here.",
  EROFS: "This location is read-only.",
  ENOENT: "That item no longer exists. The folder was refreshed.",
  ENOTEMPTY: "That folder isn't empty.",
  EEXIST: "An item with that name already exists.",
};

const PROGRAM_SVG =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><rect class="page" x="6" y="9" width="36" height="30" rx="4" /><path class="prompt" d="m14 19 5 5-5 5M23 29h10" /></svg>';

// ---------------------------------------------------------------- helpers --

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1) || "/";
const dirname = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("/"), 1));
const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const isInside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

function resolve(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const seg of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const field = <T extends HTMLElement = HTMLElement>(name: string): T =>
  document.querySelector<T>(`[data-field="${name}"]`)!;

// ------------------------------------------------------------------ state --

let os: AppInterface;
let win: WindowHandle;
let home = "/";
let cred = { euid: 0, gid: 0 };
let hour12 = false;

let cwd = "/";
let canWrite = false;
let items: Item[] = [];
let visible: Item[] = [];
const selected = new Set<string>();
let cursor = -1;
let anchor = -1;

const back: string[] = [];
const forward: string[] = [];

let view: "grid" | "list" = "grid";
let sort: { key: SortKey; dir: 1 | -1 } = { key: "name", dir: 1 };
let showHidden = false;
let query = "";

let clipboard: { paths: string[]; cut: boolean } | null = null;
let dragging: string[] | null = null;
let busy = false;

const thumbs = new Map<string, string>();

// ------------------------------------------------------------------- main --

export async function main(appOs: AppInterface, args: string[] = []): Promise<void> {
  os = appOs;
  win = await os.windows.create({ title: "Files" });
  void win.onCloseRequest(() => void os.process.exit(0));

  document.body.innerHTML = filesHTML;
  await followAccent(os);

  const [env, ids, settings] = await Promise.all([os.process.env(), os.process.ids(), loadSettings(os)]);
  home = env.HOME ?? "/";
  cred = { euid: ids.euid, gid: ids.gid };
  hour12 = !settings.clock24h;

  renderPlaces();
  bindChrome();
  bindContent();
  bindKeys();

  // Another app (Terminal, Code) may have changed the folder: re-read on focus.
  void os.events.subscribe(["window.focused"], (event) => {
    if (event.windowId === win.id && !busy) void reload();
  });

  const start = args[0] === undefined ? home : resolve(await os.process.cwd(), args[0]);
  await navigate(start, false);
  field("content").focus();
}

// ------------------------------------------------------------- navigation --

async function navigate(path: string, record = true, select: string[] = []): Promise<void> {
  try {
    const [entries, stat] = await Promise.all([os.fs.readdir(path), os.fs.stat(path)]);
    if (record && path !== cwd) {
      back.push(cwd);
      forward.length = 0;
    }
    const left = cwd;
    cwd = path;
    canWrite = !stat.readonly && permits(stat, cred, W);
    items = entries.map((entry) => ({ ...entry, path: join(path, entry.name) }));
    selected.clear();
    for (const name of select) selected.add(name);
    // Going up: land on the folder we came from, like Finder.
    if (!select.length && isInside(left, path) && left !== path) {
      selected.add(left.slice(path === "/" ? 1 : path.length + 1).split("/")[0]);
    }
    if (left !== path) {
      for (const url of thumbs.values()) URL.revokeObjectURL(url);
      thumbs.clear();
      query = "";
      field<HTMLInputElement>("search").value = "";
    }
    render();
  } catch (error) {
    if (errorCode(error) === "ENOTDIR") return navigate(dirname(path), record, [basename(path)]);
    toast(`Couldn't open “${basename(path)}”. ${ERRORS[errorCode(error)] ?? ""}`, true);
    if (!items.length && path !== "/") await navigate(dirname(path), false);
  }
}

/** Re-read the current folder, keeping the selection (or selecting `names`). */
async function reload(names?: string[]): Promise<void> {
  const keep = names ?? [...selected];
  try {
    await os.fs.stat(cwd);
    await navigate(cwd, false, keep);
  } catch {
    // The folder itself went away: climb to the nearest one that's left.
    let dir = dirname(cwd);
    while (dir !== "/" && !(await os.fs.stat(dir).then(() => true, () => false))) dir = dirname(dir);
    await navigate(dir, false);
  }
}

function goBack(): void {
  const to = back.pop();
  if (to === undefined) return;
  forward.push(cwd);
  void navigate(to, false);
}

function goForward(): void {
  const to = forward.pop();
  if (to === undefined) return;
  back.push(cwd);
  void navigate(to, false);
}

function goUp(): void {
  if (cwd !== "/") void navigate(dirname(cwd));
}

// ---------------------------------------------------------------- render --

function kindOf(item: Item): string {
  if (item.kind === "directory") return "Folder";
  if (item.kind === "fifo") return "Pipe";
  if (appFor(item)) return "Application";
  if (isProgram(item)) return "Program";
  const ext = extOf(item.name);
  if (ext === "app") return "Shortcut";
  if (IMAGE_TYPES[ext]) return `${ext.toUpperCase()} image`;
  return TYPES[ext]?.[0] ?? (ext ? `${ext.toUpperCase()} file` : "Document");
}

const appFor = (item: Item) => registry.find((app) => app.exec === item.path);
const isProgram = (item: Item): boolean => item.kind === "file" && /^\/(ProgramFiles|System)\//.test(item.path);

function sortItems(list: Item[]): Item[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return list.sort((a, b) => {
    // Folders, then apps (so Applications leads with them, not the CLI tools), then the rest.
    const rank = (item: Item): number => (item.kind === "directory" ? 0 : appFor(item) ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const { key, dir } = sort;
    const by =
      key === "name"
        ? collator.compare(a.name, b.name)
        : key === "kind"
          ? collator.compare(kindOf(a), kindOf(b)) || collator.compare(a.name, b.name)
          : a[key] - b[key] || collator.compare(a.name, b.name);
    return by * dir;
  });
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const time = { hour: "2-digit", minute: "2-digit", hour12 } as const;
  if (date.toDateString() === now.toDateString()) {
    return `Today, ${date.toLocaleTimeString(undefined, time)}`;
  }
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    ...(date.getFullYear() === now.getFullYear() ? time : {}),
  });
}

function iconFor(item: Item): HTMLElement {
  const icon = el("span", "item-icon");
  const app = appFor(item);
  const ext = extOf(item.name);

  if (item.kind === "directory") {
    icon.innerHTML = FOLDER_SVG;
    icon.classList.add("is-folder");
  } else if (app) {
    icon.append(Object.assign(el("img"), { src: app.icon, alt: "", draggable: false }));
  } else if (isProgram(item)) {
    icon.innerHTML = PROGRAM_SVG;
  } else if (ext === "app") {
    icon.innerHTML = PROGRAM_SVG;
    void readShortcut(os, item.path).then((exec) => {
      const target = registry.find((entry) => entry.exec === exec);
      if (target) icon.replaceChildren(Object.assign(el("img"), { src: target.icon, alt: "", draggable: false }));
    });
  } else if (IMAGE_TYPES[ext] && item.size <= MAX_THUMB) {
    icon.innerHTML = FILE_SVG;
    void thumbnail(item).then((url) => {
      if (!url) return;
      icon.replaceChildren(Object.assign(el("img", "thumb"), { src: url, alt: "", draggable: false }));
    });
  } else {
    icon.innerHTML = FILE_SVG;
    if (ext && ext.length <= 4) {
      const label = el("span", "ext", ext);
      label.style.color = TYPES[ext]?.[1] ?? "var(--app-text-dim)";
      icon.append(label);
    }
  }
  return icon;
}

async function thumbnail(item: Item): Promise<string | null> {
  const key = `${item.path}:${item.modifiedAt}`;
  const cached = thumbs.get(key);
  if (cached) return cached;
  try {
    const bytes = await os.fs.readFile(item.path);
    const url = URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[extOf(item.name)] }));
    thumbs.set(key, url);
    return url;
  } catch {
    return null;
  }
}

function render(): void {
  const needle = query.toLowerCase();
  visible = sortItems(
    items.filter(
      (item) =>
        (showHidden || !item.name.startsWith(".") || query) && (!needle || item.name.toLowerCase().includes(needle)),
    ),
  );
  for (const name of selected) if (!visible.some((item) => item.name === name)) selected.delete(name);
  const firstSelected = visible.findIndex((item) => selected.has(item.name));
  cursor = firstSelected;
  anchor = firstSelected;

  const content = field("content");
  content.className = `content view-${view}`;
  content.replaceChildren(
    ...visible.map((item, index) => {
      const row = el("div", "item");
      row.id = `item-${index}`;
      row.setAttribute("role", "option");
      row.dataset.index = String(index);
      row.draggable = true;
      row.title = item.name;
      row.classList.toggle("is-cut", !!clipboard?.cut && clipboard.paths.includes(item.path));
      row.classList.toggle("is-hidden-file", item.name.startsWith("."));
      row.append(
        iconFor(item),
        el("span", "item-name", item.name),
        el("span", "item-cell", formatDate(item.modifiedAt)),
        el("span", "item-cell item-size", item.kind === "directory" ? "--" : formatSize(item.size)),
        el("span", "item-cell", kindOf(item)),
      );
      return row;
    }),
  );

  field("list-head").hidden = view !== "list";
  for (const button of document.querySelectorAll<HTMLElement>("[data-sort]")) {
    const active = button.dataset.sort === sort.key;
    button.classList.toggle("is-sorted", active);
    button.classList.toggle("is-desc", active && sort.dir === -1);
    button.setAttribute("aria-sort", active ? (sort.dir === 1 ? "ascending" : "descending") : "none");
  }

  const empty = field("empty");
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    field("empty-title").textContent = query ? `Nothing named “${query}” here` : "This folder is empty";
    field("empty-hint").textContent = query
      ? "Clear the filter to see everything in this folder."
      : canWrite
        ? "Drop files here to upload them, or right-click to make a folder."
        : "";
  }

  renderCrumbs();
  renderPlacesActive();
  field("readonly").hidden = canWrite;
  for (const action of ["new-folder", "upload"]) {
    const control = document.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
    control.classList.toggle("is-disabled", !canWrite);
    control.setAttribute("aria-disabled", String(!canWrite));
  }
  field<HTMLInputElement>("upload").disabled = !canWrite;
  document.querySelector<HTMLButtonElement>('[data-action="back"]')!.disabled = !back.length;
  document.querySelector<HTMLButtonElement>('[data-action="forward"]')!.disabled = !forward.length;

  syncSelection();
  scrollToCursor();
}

function displayName(path: string): string {
  if (path === home) return "Home";
  if (path === "/") return "Computer";
  return basename(path);
}

function renderCrumbs(): void {
  const crumbs = field("crumbs");
  const root = isInside(cwd, home) ? home : "/";
  const segments = [root];
  for (let path = cwd; path !== root; path = dirname(path)) segments.splice(1, 0, path);

  crumbs.replaceChildren(
    ...segments.flatMap((path, i) => {
      const crumb = el("button", "crumb", displayName(path));
      crumb.type = "button";
      if (i === segments.length - 1) crumb.setAttribute("aria-current", "location");
      crumb.addEventListener("click", () => void navigate(path));
      makeDropTarget(crumb, () => path);
      return i ? [el("span", "crumb-sep", "›"), crumb] : [crumb];
    }),
  );
  // Deep paths clip from the left: the current folder always stays in view.
  crumbs.scrollLeft = crumbs.scrollWidth;
  crumbs.classList.toggle("is-clipped", crumbs.scrollWidth > crumbs.clientWidth);
  void win.setTitle(displayName(cwd));
}

function renderPlaces(): void {
  field("places").replaceChildren(
    ...PLACES.map((place) => {
      const path = place.path.startsWith("~") ? home + place.path.slice(1) : place.path;
      const button = el("button", "place");
      button.type = "button";
      button.dataset.path = path;
      button.title = place.label;
      button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${place.svg}</svg>`;
      button.append(place.label);
      button.addEventListener("click", () => void navigate(path));
      makeDropTarget(button, () => path);
      return button;
    }),
  );
}

function renderPlacesActive(): void {
  const places = [...document.querySelectorAll<HTMLElement>(".place")];
  // The most specific place that contains cwd: ~/docs lights Home, /etc Computer.
  const best = places
    .filter((place) => isInside(cwd, place.dataset.path!))
    .sort((a, b) => b.dataset.path!.length - a.dataset.path!.length)[0];
  for (const place of places) {
    if (place === best) place.setAttribute("aria-current", "page");
    else place.removeAttribute("aria-current");
  }
}

function syncSelection(): void {
  const content = field("content");
  for (const row of content.children as HTMLCollectionOf<HTMLElement>) {
    const index = Number(row.dataset.index);
    row.setAttribute("aria-selected", String(selected.has(visible[index].name)));
    row.classList.toggle("is-cursor", index === cursor);
  }
  if (cursor >= 0) content.setAttribute("aria-activedescendant", `item-${cursor}`);
  else content.removeAttribute("aria-activedescendant");
  renderSummary();
}

function renderSummary(): void {
  const count = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;
  const chosen = selectedItems();
  const bytes = chosen.reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0);
  field("summary").textContent = chosen.length
    ? `${chosen.length} of ${count(visible.length)} selected${bytes ? ` · ${formatSize(bytes)}` : ""}`
    : count(visible.length);
}

function scrollToCursor(): void {
  document.getElementById(`item-${cursor}`)?.scrollIntoView({ block: "nearest" });
}

// -------------------------------------------------------------- selection --

const selectedItems = (): Item[] => visible.filter((item) => selected.has(item.name));

function selectOnly(index: number): void {
  selected.clear();
  if (visible[index]) selected.add(visible[index].name);
  cursor = anchor = index;
  syncSelection();
}

function selectRange(to: number): void {
  selected.clear();
  const from = Math.max(anchor, 0);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(visible[i].name);
  cursor = to;
  syncSelection();
}

function toggle(index: number): void {
  const name = visible[index].name;
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  cursor = anchor = index;
  syncSelection();
}

function moveCursor(to: number, extend: boolean): void {
  if (!visible.length) return;
  const index = Math.max(0, Math.min(visible.length - 1, to));
  if (extend) selectRange(index);
  else selectOnly(index);
  scrollToCursor();
}

/** Items per row in icon view, from where the browser actually wrapped them. */
function columns(): number {
  if (view === "list") return 1;
  const rows = [...field("content").children] as HTMLElement[];
  const top = rows[0]?.offsetTop;
  const perRow = rows.findIndex((row) => row.offsetTop !== top);
  return perRow === -1 ? rows.length : perRow;
}

// ---------------------------------------------------------------- opening --

async function open(item: Item): Promise<void> {
  if (item.kind === "directory") return navigate(item.path);
  const app = appFor(item);
  if (app) {
    await os.process.spawn(app.exec).catch((error) => toast(`Couldn't start ${app.name}. ${ERRORS[errorCode(error)] ?? ""}`, true));
    return;
  }
  if (isProgram(item)) return openTerminalHere(dirname(item.path) === "/ProgramFiles" ? item.name : item.path);
  const exec = await readShortcut(os, item.path);
  if (exec) {
    await os.process.spawn(exec).catch((error) => toast(`Couldn't start ${item.name}. ${ERRORS[errorCode(error)] ?? ""}`, true));
    return;
  }
  const { openWith } = await loadSettings(os);
  await os.process.spawn(defaultAppFor(item.path, openWith), [item.path]).catch((error) => toast(`Couldn't open ${item.name} (${errorCode(error)}).`, true));
}

/** Terminal in the current folder, optionally running `command` there. */
async function openTerminalHere(command?: string): Promise<void> {
  // The terminal's shell starts in its parent's cwd: ours.
  await os.process.chdir(cwd);
  await os.process.spawn("/ProgramFiles/terminal", command ? [command] : []).catch((error) => toast(`Couldn't open Terminal (${errorCode(error)}).`, true));
}

// ------------------------------------------------------------- operations --

/** Run a mutation, then show the folder as it is now, whatever happened. */
async function mutate(task: () => Promise<string[] | void>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.classList.add("is-busy");
  let names: string[] | void = undefined;
  try {
    names = await task();
  } catch (error) {
    toast(ERRORS[errorCode(error)] ?? `Something went wrong (${errorCode(error)}).`, true);
  } finally {
    busy = false;
    document.body.classList.remove("is-busy");
    await reload(names || undefined);
  }
}

// ponytail: no rename syscall, so moves and renames are copy + delete, like mv.
async function copyTree(src: string, dst: string): Promise<void> {
  const stat = await os.fs.stat(src);
  if (stat.kind === "directory") {
    await os.fs.mkdir(dst);
    for (const entry of await os.fs.readdir(src)) await copyTree(join(src, entry.name), join(dst, entry.name));
  } else if (stat.kind === "file") {
    await os.fs.writeFile(dst, await os.fs.readFile(src));
  }
}

async function removeTree(path: string): Promise<void> {
  const stat = await os.fs.stat(path);
  if (stat.kind === "directory") {
    for (const entry of await os.fs.readdir(path)) await removeTree(join(path, entry.name));
    await os.fs.rmdir(path);
  } else {
    await os.fs.unlink(path);
  }
}

/** Copy or move `paths` into `dir`. Returns the names they landed under. */
async function transfer(paths: string[], dir: string, move: boolean): Promise<string[]> {
  const taken = new Set((await os.fs.readdir(dir)).map((entry) => entry.name));
  const landed: string[] = [];
  for (const src of paths) {
    if (isInside(dir, src)) throw Object.assign(new Error(), { code: "EINVAL_INTO_SELF" });
    if (move && dirname(src) === dir) {
      landed.push(basename(src));
      continue;
    }
    const name = freeName(basename(src), taken);
    taken.add(name);
    await copyTree(src, join(dir, name));
    if (move) await removeTree(src);
    landed.push(name);
  }
  return landed;
}
ERRORS.EINVAL_INTO_SELF = "A folder can't be moved or copied into itself.";

function copy(cut: boolean): void {
  const chosen = selectedItems();
  if (!chosen.length) return;
  clipboard = { paths: chosen.map((item) => item.path), cut };
  render();
  toast(`${cut ? "Cut" : "Copied"} ${chosen.length === 1 ? `“${chosen[0].name}”` : `${chosen.length} items`}. Paste in any folder.`);
}

function paste(): void {
  const clip = clipboard;
  if (!clip || !canWrite) return;
  void mutate(async () => {
    const names = await transfer(clip.paths, cwd, clip.cut);
    if (clip.cut) clipboard = null;
    return names;
  });
}

function moveInto(paths: string[], dir: string, copyOnly: boolean): void {
  void mutate(async () => {
    await transfer(paths, dir, !copyOnly);
    toast(`${copyOnly ? "Copied" : "Moved"} ${paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`} to ${displayName(dir)}.`);
  });
}

async function remove(): Promise<void> {
  const chosen = selectedItems();
  if (!chosen.length || !canWrite) return;
  const what = chosen.length === 1 ? `“${chosen[0].name}”` : `${chosen.length} items`;
  if (!(await confirmDelete(`Delete ${what}?`))) return;
  void mutate(async () => {
    for (const item of chosen) await removeTree(item.path);
    if (clipboard) clipboard.paths = clipboard.paths.filter((p) => !chosen.some((item) => isInside(p, item.path)));
    return [];
  });
}

function create(kind: "directory" | "file"): void {
  if (!canWrite) return;
  void mutate(async () => {
    const name = freeName(kind === "directory" ? "untitled folder" : "untitled.txt", new Set(items.map((i) => i.name)), "");
    if (kind === "directory") await os.fs.mkdir(join(cwd, name));
    else await os.fs.writeFile(join(cwd, name), new Uint8Array());
    return [name];
  }).then(() => {
    const index = visible.findIndex((item) => selected.has(item.name));
    if (index >= 0) rename(index);
  });
}

function upload(files: File[], dir = cwd): void {
  const fit = files.filter((file) => file.size <= MAX_UPLOAD);
  if (fit.length < files.length) toast(`Skipped ${files.length - fit.length} file(s) over 20 MB.`, true);
  if (!fit.length) return;
  void mutate(async () => {
    const taken = new Set((await os.fs.readdir(dir)).map((entry) => entry.name));
    const names: string[] = [];
    for (const file of fit) {
      const name = freeName(file.name, taken);
      taken.add(name);
      await os.fs.writeFile(join(dir, name), new Uint8Array(await file.arrayBuffer()));
      names.push(name);
    }
    if (dir !== cwd) toast(`Uploaded ${names.length} file(s) to ${displayName(dir)}.`);
    return dir === cwd ? names : undefined;
  });
}

/** Inline rename: the name becomes a text field. Enter or blur commits. */
function rename(index: number): void {
  const item = visible[index];
  const row = document.getElementById(`item-${index}`);
  if (!item || !row || !canWrite) return;
  selectOnly(index);
  const label = row.querySelector<HTMLElement>(".item-name")!;
  const input = Object.assign(el("input", "rename"), { value: item.name, spellcheck: false });
  input.setAttribute("aria-label", `Rename ${item.name}`);
  label.replaceChildren(input);
  row.draggable = false;
  input.focus();
  const dot = item.kind === "file" ? item.name.lastIndexOf(".") : -1;
  input.setSelectionRange(0, dot > 0 ? dot : item.name.length);

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    field("content").focus();
    if (!commit || name === item.name || !name) return void (label.textContent = item.name);
    if (name.includes("/") || name === "." || name === "..") {
      label.textContent = item.name;
      return toast("Names can't contain “/” or be “.” or “..”.", true);
    }
    if (items.some((other) => other.name === name)) {
      label.textContent = item.name;
      return toast(`“${name}” already exists in this folder.`, true);
    }
    label.textContent = name;
    void mutate(async () => {
      await copyTree(item.path, join(cwd, name));
      await removeTree(item.path);
      return [name];
    });
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  for (const type of ["pointerdown", "click", "dblclick"]) input.addEventListener(type, (event) => event.stopPropagation());
}

// ---------------------------------------------------------------- dialogs --

function confirmDelete(title: string): Promise<boolean> {
  const dialog = field<HTMLDialogElement>("confirm");
  field("confirm-title").textContent = title;
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('[value="cancel"]')!.focus();
  return new Promise((done) => {
    const onClick = (event: Event): void => {
      const value = (event.target as HTMLElement).closest("button")?.value;
      if (value) dialog.close(value);
    };
    dialog.addEventListener("click", onClick);
    dialog.addEventListener(
      "close",
      () => {
        dialog.removeEventListener("click", onClick);
        field("content").focus();
        done(dialog.returnValue === "ok");
      },
      { once: true },
    );
    dialog.returnValue = "";
  });
}

/** Quick Look: Space previews the item under the cursor; arrows walk the folder. */
async function peek(item = visible[cursor]): Promise<void> {
  if (!item) return;
  const dialog = field<HTMLDialogElement>("peek");
  const body = field("peek-body");
  field("peek-name").textContent = item.name;
  field("peek-meta").textContent = [
    kindOf(item),
    item.kind === "directory" ? "" : formatSize(item.size),
    formatDate(item.modifiedAt),
  ]
    .filter(Boolean)
    .join(" · ");
  dialog.dataset.path = item.path;

  const fallback = (): void => {
    const big = iconFor(item);
    big.classList.add("peek-icon");
    body.replaceChildren(big);
  };
  body.className = "peek-body";
  const ext = extOf(item.name);
  if (item.kind === "file" && IMAGE_TYPES[ext] && item.size <= MAX_THUMB) {
    const url = await thumbnail(item);
    if (url) {
      body.classList.add("is-image");
      body.replaceChildren(Object.assign(el("img"), { src: url, alt: item.name }));
    } else fallback();
  } else if (item.kind === "file" && !isProgram(item) && item.size > 0) {
    try {
      const bytes = (await os.fs.readFile(item.path)).slice(0, MAX_PEEK_TEXT);
      if (bytes.includes(0)) throw new Error("binary");
      body.classList.add("is-text");
      body.replaceChildren(el("pre", "", new TextDecoder().decode(bytes)));
    } catch {
      fallback();
    }
  } else fallback();

  if (!dialog.open) dialog.showModal();
}

// ------------------------------------------------------------------- menu --

interface MenuEntry {
  label: string;
  hint?: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

const MOD = IS_MAC ? "⌘" : "Ctrl+";

function openMenu(x: number, y: number, entries: (MenuEntry | null)[]): void {
  const menu = field("menu");
  menu.replaceChildren(
    ...entries.map((entry) => {
      if (!entry) return Object.assign(el("div", "menu-sep"), { role: "separator" });
      const button = el("button", `menu-item${entry.danger ? " is-danger" : ""}`);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.disabled = !!entry.disabled;
      button.append(el("span", "", entry.label), el("span", "menu-hint", entry.hint ?? ""));
      button.addEventListener("click", () => {
        closeMenu();
        entry.action();
      });
      return button;
    }),
  );
  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 4)}px`;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function closeMenu(): void {
  const menu = field("menu");
  if (menu.hidden) return;
  menu.hidden = true;
  field("content").focus();
}

function itemMenu(): (MenuEntry | null)[] {
  const chosen = selectedItems();
  const one = chosen.length === 1 ? chosen[0] : null;
  return [
    { label: "Open", hint: "Enter", action: () => void (one && open(one)), disabled: !one },
    {
      label: "Open in Code",
      action: () => void (one && os.process.spawn("/ProgramFiles/code", [one.path])),
      disabled: !one || one.kind !== "file" || isProgram(one),
    },
    { label: "Quick Look", hint: "Space", action: () => void peek(one ?? undefined), disabled: !one },
    null,
    { label: "Rename", hint: "F2", action: () => rename(cursor), disabled: !one || !canWrite },
    { label: "Copy", hint: `${MOD}C`, action: () => copy(false) },
    { label: "Cut", hint: `${MOD}X`, action: () => copy(true), disabled: !canWrite },
    null,
    { label: "Delete", hint: "Del", action: () => void remove(), disabled: !canWrite, danger: true },
  ];
}

function folderMenu(): (MenuEntry | null)[] {
  return [
    { label: "New folder", hint: "Alt+N", action: () => create("directory"), disabled: !canWrite },
    { label: "New text file", action: () => create("file"), disabled: !canWrite },
    { label: "Upload files…", action: () => field("upload").click(), disabled: !canWrite },
    null,
    {
      label: clipboard && clipboard.paths.length > 1 ? `Paste ${clipboard.paths.length} items` : "Paste",
      hint: `${MOD}V`,
      action: paste,
      disabled: !clipboard || !canWrite,
    },
    null,
    { label: showHidden ? "Hide hidden files" : "Show hidden files", hint: `${MOD}⇧.`, action: toggleHidden },
    { label: "Open in Terminal", action: () => void openTerminalHere() },
  ];
}

function toggleHidden(): void {
  showHidden = !showHidden;
  render();
}

// ------------------------------------------------------------------ toast --

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(text: string, isError = false): void {
  const node = field("toast");
  node.textContent = text;
  node.classList.toggle("is-error", isError);
  node.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-shown"), isError ? 5000 : 2600);
}

// --------------------------------------------------------------- bindings --

function bindChrome(): void {
  const action = (name: string, run: () => void): void =>
    document.querySelector(`[data-action="${name}"]`)!.addEventListener("click", run);
  action("back", goBack);
  action("forward", goForward);
  action("new-folder", () => create("directory"));
  action("peek-open", () => {
    const dialog = field<HTMLDialogElement>("peek");
    const item = visible.find((i) => i.path === dialog.dataset.path);
    dialog.close();
    if (item) void open(item);
  });

  const upload$ = field<HTMLInputElement>("upload");
  upload$.addEventListener("change", () => {
    const files = [...(upload$.files ?? [])];
    upload$.value = "";
    upload(files);
  });

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="view"]')) {
    radio.addEventListener("change", () => {
      view = radio.value as typeof view;
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLElement>("[data-sort]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.sort as SortKey;
      sort = { key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 };
      render();
    });
  }

  const search = field<HTMLInputElement>("search");
  search.addEventListener("input", () => {
    query = search.value.trim();
    render();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      query = "";
      render();
      field("content").focus();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      field("content").focus();
      if (cursor < 0) moveCursor(0, false);
    }
  });

  // Peek dialog: Space/Escape close, arrows step through the folder.
  const peekDialog = field<HTMLDialogElement>("peek");
  peekDialog.addEventListener("keydown", (event) => {
    const step = { ArrowDown: columns(), ArrowRight: 1, ArrowUp: -columns(), ArrowLeft: -1 }[event.key];
    if (event.key === " ") {
      event.preventDefault();
      peekDialog.close();
    } else if (step !== undefined) {
      event.preventDefault();
      moveCursor(cursor + step, false);
      void peek();
    }
  });
  peekDialog.addEventListener("click", (event) => {
    if (event.target === peekDialog) peekDialog.close();
  });
  peekDialog.addEventListener("close", () => field("content").focus());

  const menu = field("menu");
  menu.addEventListener("keydown", (event) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeMenu();
    } else if (next !== undefined) {
      event.preventDefault();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
}

/** Folders, places and crumbs accept dropped items (move; Alt copies) and files (upload). */
function makeDropTarget(node: HTMLElement, target: () => string | null): void {
  const accepts = (event: DragEvent): string | null => {
    const dir = target();
    if (!dir) return null;
    if (dragging) return dragging.some((path) => isInside(dir, path) || dirname(path) === dir) ? null : dir;
    return event.dataTransfer?.types.includes("Files") ? dir : null;
  };
  node.addEventListener("dragover", (event) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = dragging && !event.altKey ? "move" : "copy";
    node.classList.add("is-drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("is-drop-target"));
  node.addEventListener("drop", (event) => {
    node.classList.remove("is-drop-target");
    const dir = accepts(event);
    if (!dir) return;
    event.preventDefault();
    event.stopPropagation();
    hideDropHint();
    if (dragging) moveInto(dragging, dir, event.altKey);
    else upload([...(event.dataTransfer?.files ?? [])], dir);
  });
}

function hideDropHint(): void {
  field("drop-hint").hidden = true;
}

function bindContent(): void {
  const content = field("content");
  const indexOf = (event: Event): number => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".item");
    return row ? Number(row.dataset.index) : -1;
  };

  content.addEventListener("pointerdown", (event) => {
    if (event.button === 1) return;
    const index = indexOf(event);
    if (index < 0) {
      if (event.button === 0 && !event.shiftKey && !(IS_MAC ? event.metaKey : event.ctrlKey)) selectOnly(-1);
      return;
    }
    if (event.shiftKey) selectRange(index);
    else if (IS_MAC ? event.metaKey : event.ctrlKey) toggle(index);
    else if (!selected.has(visible[index].name)) selectOnly(index);
    else {
      cursor = index;
      syncSelection();
    }
  });
  content.addEventListener("click", (event) => {
    const index = indexOf(event);
    // A plain click on one of several selected items narrows to it (drag keeps all).
    if (index >= 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && selected.size > 1) selectOnly(index);
  });
  content.addEventListener("dblclick", (event) => {
    const index = indexOf(event);
    if (index >= 0) void open(visible[index]);
  });
  content.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const index = indexOf(event);
    if (index >= 0 && !selected.has(visible[index].name)) selectOnly(index);
    if (index < 0) selectOnly(-1);
    openMenu(event.clientX, event.clientY, index >= 0 ? itemMenu() : folderMenu());
  });

  // Dragging items out of the view.
  content.addEventListener("dragstart", (event) => {
    const index = indexOf(event);
    if (index < 0) return;
    if (!selected.has(visible[index].name)) selectOnly(index);
    dragging = selectedItems().map((item) => item.path);
    event.dataTransfer!.setData(DRAG_TYPE, JSON.stringify(dragging));
    event.dataTransfer!.effectAllowed = "copyMove";
  });
  content.addEventListener("dragend", () => {
    dragging = null;
  });

  // Folders inside the view are drop targets; the row decides which folder.
  content.addEventListener("dragover", (event) => {
    const index = indexOf(event);
    const item = visible[index];
    const folder = item?.kind === "directory" ? item.path : null;
    for (const row of content.querySelectorAll(".is-drop-target")) row.classList.remove("is-drop-target");
    if (folder && (!dragging || !dragging.some((path) => isInside(folder, path)))) {
      event.preventDefault();
      event.dataTransfer!.dropEffect = dragging && !event.altKey ? "move" : "copy";
      document.getElementById(`item-${index}`)!.classList.add("is-drop-target");
      hideDropHint();
      return;
    }
    // Files from the computer over the background: upload here.
    if (!dragging && event.dataTransfer?.types.includes("Files") && canWrite) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const hint = field("drop-hint");
      hint.textContent = `Drop to upload to ${displayName(cwd)}`;
      hint.hidden = false;
    }
  });
  content.addEventListener("dragleave", (event) => {
    if (!content.contains(event.relatedTarget as Node)) {
      hideDropHint();
      for (const row of content.querySelectorAll(".is-drop-target")) row.classList.remove("is-drop-target");
    }
  });
  content.addEventListener("drop", (event) => {
    event.preventDefault();
    hideDropHint();
    for (const row of content.querySelectorAll(".is-drop-target")) row.classList.remove("is-drop-target");
    const item = visible[indexOf(event)];
    const dir = item?.kind === "directory" ? item.path : null;
    if (dragging) {
      if (dir) moveInto(dragging, dir, event.altKey);
    } else if (event.dataTransfer?.files.length) {
      upload([...event.dataTransfer.files], dir ?? cwd);
    }
  });
}

let typed = "";
let typedTimer: ReturnType<typeof setTimeout> | undefined;

function bindKeys(): void {
  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("dialog, .menu") || target instanceof HTMLInputElement) return;
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    const item = visible[cursor];
    const cols = columns();
    let handled = true;

    if (event.altKey && event.key === "ArrowLeft") goBack();
    else if (event.altKey && event.key === "ArrowRight") goForward();
    else if ((event.altKey || mod) && event.key === "ArrowUp") goUp();
    else if (mod && event.key === "ArrowDown") void (item && open(item));
    else if (event.altKey && event.code === "KeyN") create("directory");
    else if (mod && event.code === "KeyF") field("search").focus();
    else if (mod && event.code === "KeyA") {
      for (const i of visible) selected.add(i.name);
      syncSelection();
    } else if (mod && event.code === "KeyC") copy(false);
    else if (mod && event.code === "KeyX") copy(true);
    else if (mod && event.code === "KeyV") paste();
    else if (mod && event.shiftKey && event.code === "Period") toggleHidden();
    else if (mod) handled = false;
    else if (event.key === "ArrowDown") moveCursor(cursor < 0 ? 0 : cursor + cols, event.shiftKey);
    else if (event.key === "ArrowUp") moveCursor(cursor < 0 ? 0 : cursor - cols, event.shiftKey);
    else if (event.key === "ArrowRight" && view === "grid") moveCursor(cursor + 1, event.shiftKey);
    else if (event.key === "ArrowLeft" && view === "grid") moveCursor(cursor - 1, event.shiftKey);
    else if (event.key === "Home") moveCursor(0, event.shiftKey);
    else if (event.key === "End") moveCursor(visible.length - 1, event.shiftKey);
    else if (event.key === "Enter") void (item && open(item));
    else if (event.key === "Backspace") goUp();
    else if (event.key === " ") void peek();
    else if (event.key === "F2") rename(cursor);
    else if (event.key === "Delete") void remove();
    else if (event.key === "Escape") {
      if (query) {
        query = "";
        field<HTMLInputElement>("search").value = "";
        render();
      } else selectOnly(-1);
    } else if (event.key.length === 1 && !event.altKey) {
      // Type-ahead: jump to the first name starting with what was typed.
      clearTimeout(typedTimer);
      typed += event.key.toLowerCase();
      typedTimer = setTimeout(() => (typed = ""), 700);
      const match = visible.findIndex((i) => i.name.toLowerCase().startsWith(typed));
      if (match >= 0) moveCursor(match, false);
    } else handled = false;

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
