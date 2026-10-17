// Spotlight — Cmd+K (Ctrl+K off a Mac): one field to open an app, switch to
// a window, run one of an app's commands, such as Todo's "New todo", or open
// a file from home (files.ts) in the app it opens with.
//
// A privileged system app in an overlay surface (binfmt): no frame, over
// every window, hidden until the hotkey, which it claims from the kernel. It
// stays running, so it opens at once. The desktop session starts it
// (/etc/autostart), as the user, and it ends with the session.
//
// Commands are declared by the apps and run headless as their own programs
// (utils/commands.ts): Spotlight spawns one with a pipe for its stdout and
// reads back one line of JSON. Apps that answer searches are asked the same
// way while something is typed, and their results run their own commands.
// Nothing an app declares is ever run here, and it is only ever shown as text.
import { logError } from "../../kernel/errors";
import { ADMIN_GID } from "../../kernel/fs/perm";
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid, WindowId } from "../../kernel/types";
import type { WindowInfo } from "../../kernel/windows/types";
import { allApps, type AppEntry } from "../../apps/registry";
import {
  parseResult,
  parseSearch,
  SEARCH_FLAG,
  type CommandResult,
  type CommandSpec,
} from "../../utils/commands";
import { defaultAppFor, FILE_SVG, FOLDER_SVG } from "../../utils/filetypes";
import { ensureConfigDir, followAccent, loadSettings } from "../../utils/settings";
import { affects, walk, where, type FileEntry } from "./files";
import { rank, score } from "./search";
import spotlightHTML from "./spotlight.html?raw";
import "../../ui/theme.css";
import "./spotlight.css";

const DEFAULT_ICON = "/assets/icons/default-app.svg";
const FILES_APP = "/ProgramFiles/files";
/** Recently opened apps and run commands, shown before anything is typed. */
const RECENTS = 5;
/** Per group, while searching. */
const PER_GROUP = 6;
/** The results list grows to this, then scrolls. */
const MAX_LIST = 380;
/** A command that hasn't answered by now is killed. */
const COMMAND_TIMEOUT_MS = 8000;
/** Apps are asked for results once typing pauses this long... */
const SEARCH_DELAY_MS = 140;
/** ...and have this long to answer. */
const SEARCH_TIMEOUT_MS = 3000;
/** How long a command's "done" stays up before Spotlight goes. */
const DONE_MS = 1100;
/** Changes under home while Spotlight is up are re-walked once they settle this long. */
const REINDEX_DELAY_MS = 400;

interface Base {
  key: string;
  title: string;
  also: string[];
  icon: string;
}
type AppItem = Base & { kind: "app"; entry: AppEntry };
type CommandItem = Base & { kind: "command"; entry: AppEntry; spec: CommandSpec };
type WindowItem = Base & { kind: "window"; info: WindowInfo; app?: string };
/** Something an app found for the query: choosing it runs `spec` with `input`. */
type ResultItem = Base & { kind: "result"; entry: AppEntry; spec: CommandSpec; input: string; detail?: string };
/** A file or folder under home; `icon` is unused, it is drawn as a page or folder. */
type FileItem = Base & { kind: "file"; file: FileEntry };
type Item = AppItem | CommandItem | WindowItem | ResultItem | FileItem;
/** What can be run: a command, or a result standing in for one. */
type Runnable = CommandItem | ResultItem;

let os: AppInterface;
let windowId: WindowId;
let visible = false;

let apps: AppEntry[] = [];
let windows: WindowItem[] = [];
let recents: string[] = [];
let recentsFile = "";
let home = "/";
/** The user's extension -> app picks (settings.openWith), as of the last show. */
let openWith: Record<string, string> = {};

/** What's under home, from the last walk; `stale` once something there changed since. */
let files: FileItem[] = [];
let stale = true;
let indexing = false;
let reindexTimer: ReturnType<typeof setTimeout> | undefined;

/** What the list shows now, in keyboard order. */
let shown: Item[] = [];
let selected = 0;
/** A command that takes text, chosen: the field is its input. */
let commandMode: { item: CommandItem; query: string } | null = null;
let running = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

/** The apps' results for the query being typed; `searching` names that query. */
let found: ResultItem[] = [];
let searching = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export async function main(appOs: AppInterface): Promise<void> {
  os = appOs;
  await followAccent(os);
  const handle = await os.windows.create({ title: "Spotlight" });
  windowId = handle.id;
  // Ctrl+W, or a close from anywhere else, only ever hides an overlay.
  document.body.innerHTML = spotlightHTML;

  recentsFile = `${await ensureConfigDir(os)}/spotlight.json`;
  recents = await loadRecents();
  home = (await os.process.env()).HOME ?? "/";
  void os.events.subscribe(["fs.changed"], (event) => {
    if (!affects(home, event.path)) return;
    stale = true;
    if (!visible) return; // walked again when next opened
    clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => void reindex(), REINDEX_DELAY_MS);
  });

  const input = $<HTMLInputElement>("query");
  input.addEventListener("input", () => {
    if (commandMode) return setStatus(null);
    selected = 0;
    askApps(input.value.trim());
    render();
  });
  input.addEventListener("keydown", onKey);

  const results = $("results");
  results.addEventListener("pointermove", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (row && Number(row.dataset.index) !== selected) select(Number(row.dataset.index), false);
  });
  results.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (row) void activate(shown[Number(row.dataset.index)]!);
  });
  // Keep the keyboard in the field when a row is clicked.
  results.addEventListener("pointerdown", (event) => event.preventDefault());

  // Focus going anywhere else (another window, the desktop) puts us away,
  // like a popover. The kernel hides us too; this keeps `visible` true to it.
  window.addEventListener("blur", () => {
    if (visible) hide();
  });

  await os.display.claimHotkey("palette", () => (visible ? hide() : void show()));
  void refresh().then(() => render());
}

// ------------------------------------------------------------ show / hide --

async function show(): Promise<void> {
  clearTimeout(hideTimer);
  visible = true;
  leaveCommand(false);
  askApps("");
  const input = $<HTMLInputElement>("query");
  input.value = "";
  input.disabled = false;
  setStatus(null);
  setBusy(false);
  selected = 0;
  render();
  await os.windows.setVisible(windowId, true);
  input.focus();
  if (stale) void reindex();
  // What's installed and open may have changed since; draw it when we know.
  await refresh();
  if (visible && !commandMode) render(true);
}

function hide(): void {
  clearTimeout(hideTimer);
  visible = false;
  void os.windows.setVisible(windowId, false).catch(logError);
}

async function refresh(): Promise<void> {
  try {
    const [all, ids, list, procs, settings] = await Promise.all([
      allApps(os),
      os.process.ids(),
      os.windows.list(),
      os.process.list(),
      loadSettings(os),
    ]);
    openWith = settings.openWith;
    // Cosmetic, like the taskbar's menu: an admin app's exec fails for others anyway.
    apps = all.filter((app) => !app.admin || ids.gid === ADMIN_GID);
    const paths = new Map<Pid, string>(procs.map((proc) => [proc.pid, proc.path]));
    windows = list.map((info): WindowItem => {
      const app = apps.find((entry) => entry.exec === paths.get(info.pid));
      return {
        kind: "window",
        key: `window:${info.windowId}`,
        title: info.title || app?.name || "Window",
        also: app ? [app.name] : [],
        icon: app?.icon ?? DEFAULT_ICON,
        info,
        app: app?.name,
      };
    });
  } catch (error) {
    logError(error);
  }
}

/** Walk home again, then redraw with what it found. One walk at a time; a change during it walks again after. */
async function reindex(): Promise<void> {
  if (indexing) return;
  indexing = true;
  stale = false;
  try {
    const found = await walk((path) => os.fs.readdir(path), home);
    files = found.map((file) => ({
      kind: "file",
      key: `file:${file.path}`,
      title: file.name,
      also: [],
      icon: "",
      file,
    }));
  } catch (error) {
    logError(error);
  } finally {
    indexing = false;
  }
  if (stale && visible) return reindex();
  if (visible && !commandMode) render(true);
}

/** The app a file opens in, as Files and the desktop would open it. */
const openerOf = (file: FileEntry): string => (file.dir ? FILES_APP : defaultAppFor(file.path, openWith));

// ----------------------------------------------------------------- items --

const appItems = (): AppItem[] =>
  apps.map((entry) => ({
    kind: "app",
    key: `app:${entry.id}`,
    title: entry.name,
    also: [],
    icon: entry.icon,
    entry,
  }));

const commandItems = (): CommandItem[] =>
  apps.flatMap((entry) =>
    (entry.run ? (entry.commands ?? []).filter((spec) => !spec.hidden) : []).map(
      (spec): CommandItem => ({
        kind: "command",
        key: `command:${entry.id}/${spec.id}`,
        title: spec.title,
        also: [...(spec.keywords ?? []), entry.name],
        icon: entry.icon,
        entry,
        spec,
      }),
    ),
  );

interface Section {
  label: string;
  items: Item[];
}

function sections(query: string): Section[] {
  if (!query) {
    const everything: Item[] = [...appItems(), ...commandItems(), ...files];
    const recent = recents
      .flatMap((key) => everything.find((item) => item.key === key) ?? [])
      .slice(0, RECENTS);
    const byName = appItems().sort((a, b) => a.title.localeCompare(b.title));
    return [
      { label: "Recent", items: recent },
      { label: "Apps", items: byName },
    ];
  }
  const groups: Section[] = [
    { label: "Apps", items: rank(query, appItems()) },
    { label: "Commands", items: rank(query, commandItems()) },
    { label: "Windows", items: rank(query, windows) },
    { label: "Files", items: rank(query, files) },
    // What each app found, under its name, in the order it gave.
    ...apps.flatMap((entry) => {
      const items = found.filter((item) => item.entry === entry);
      return items.length ? [{ label: entry.name, items }] : [];
    }),
  ];
  // The group with the best match first; the order above breaks ties. An
  // app's result may match on more than its title (a site's address): it
  // still counts, for little.
  const best = (section: Section) =>
    section.items[0] ? Math.max(score(query, section.items[0]), section.items[0].kind === "result" ? 1 : 0) : 0;
  return groups
    .map((section) => ({ ...section, items: section.items.slice(0, PER_GROUP) }))
    .sort((a, b) => best(b) - best(a));
}

// ---------------------------------------------------------------- render --

/** `keep`: stay on the same item if it is still there (a refresh), rather than the top one. */
function render(keep = false): void {
  const list = document.createElement("div");
  list.className = "list";
  const was = keep ? shown[selected]?.key : undefined;
  shown = [];

  if (!commandMode) {
    const query = $<HTMLInputElement>("query").value.trim();
    for (const section of sections(query)) {
      if (section.items.length === 0) continue;
      const header = document.createElement("div");
      header.className = "section";
      header.textContent = section.label;
      list.append(header);
      for (const item of section.items) {
        list.append(row(item, shown.length));
        shown.push(item);
      }
    }
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = query ? `Nothing found for “${query}”` : "No apps";
      list.append(empty);
    }
    const kept = was ? shown.findIndex((item) => item.key === was) : -1;
    selected = kept >= 0 ? kept : Math.min(selected, Math.max(shown.length - 1, 0));
  }

  const results = $("results");
  results.replaceChildren(list);
  results.hidden = commandMode !== null;
  select(selected, true);
  fit();
}

function row(item: Item, index: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  el.id = `row-${index}`;
  el.dataset.index = String(index);
  el.setAttribute("role", "option");

  let icon: HTMLElement;
  if (item.kind === "file") {
    icon = document.createElement("span");
    icon.className = "icon file-icon";
    icon.innerHTML = item.file.dir ? FOLDER_SVG : FILE_SVG;
  } else {
    const img = document.createElement("img");
    img.className = "icon";
    img.alt = "";
    img.src = item.icon;
    img.addEventListener("error", () => (img.src = DEFAULT_ICON), { once: true });
    icon = img;
  }

  const text = document.createElement("span");
  text.className = "text";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = item.title;
  text.append(title);
  const sub = subtitle(item);
  if (sub) {
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = sub;
    text.append(detail);
  }

  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent =
    item.kind === "result"
      ? item.spec.title
      : item.kind === "file"
        ? item.file.dir ? "Folder" : "File"
        : { app: "App", command: "Command", window: "Window" }[item.kind];

  el.append(icon, text, kind);
  return el;
}

/** Whose it is: a command or window shows its app, so no app can pass its command off as another's. */
function subtitle(item: Item): string {
  if (item.kind === "command") return item.entry.name;
  if (item.kind === "result") return item.detail ?? "";
  if (item.kind === "file") return where(home, item.file.path);
  if (item.kind === "window") {
    const app = item.app === item.title ? "" : item.app;
    return [app, item.info.minimized ? "minimized" : ""].filter(Boolean).join(" · ");
  }
  return "";
}

function select(index: number, scroll: boolean): void {
  selected = index;
  const input = $<HTMLInputElement>("query");
  for (const el of $("results").querySelectorAll<HTMLElement>(".row")) {
    const on = Number(el.dataset.index) === index;
    el.classList.toggle("selected", on);
    el.setAttribute("aria-selected", String(on));
    if (on && scroll) el.scrollIntoView({ block: "nearest" });
  }
  const item = shown[index];
  if (item && !commandMode) input.setAttribute("aria-activedescendant", `row-${index}`);
  else input.removeAttribute("aria-activedescendant");
  footer();
}

function footer(): void {
  const hint = $("footer-hint");
  if (commandMode) {
    hint.textContent = `↵ ${commandMode.item.spec.title} · ⌫ back`;
    return;
  }
  const item = shown[selected];
  if (!item) return void (hint.textContent = "");
  if (item.kind === "file") {
    const exec = openerOf(item.file);
    const app = apps.find((entry) => entry.exec === exec);
    return void (hint.textContent = app ? `↵ Open in ${app.name}` : "↵ Open");
  }
  hint.textContent =
    item.kind === "app"
      ? `↵ Open ${item.title}`
      : item.kind === "window"
        ? "↵ Switch to it"
        : item.kind === "result"
          ? `↵ ${item.spec.title} · ${item.entry.name}`
          : item.spec.input
          ? `↵ or tab: ${item.title}`
          : `↵ ${item.title}`;
}

/** Ask the kernel for exactly our height: an iframe can't size itself. */
let lastHeight = 0;
function fit(): void {
  requestAnimationFrame(() => {
    const panel = $("panel");
    const list = $("results").querySelector<HTMLElement>(".list");
    const listHeight = $("results").hidden ? 0 : Math.min(list?.offsetHeight ?? 0, MAX_LIST);
    const rest = [...panel.children]
      .filter((child) => child.id !== "results" && !(child as HTMLElement).hidden)
      .reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
    const height = Math.ceil(rest + listHeight);
    if (height === lastHeight) return;
    lastHeight = height;
    void os.windows.setSize(windowId, { height }).catch(logError);
  });
}

function setStatus(status: { text: string; error?: boolean } | null): void {
  const el = $("status");
  el.hidden = status === null;
  el.textContent = status?.text ?? "";
  el.classList.toggle("error", status?.error === true);
  fit();
}

function setBusy(busy: boolean): void {
  running = busy;
  $("busy").hidden = !busy;
}

// -------------------------------------------------------------- keyboard --

function onKey(event: KeyboardEvent): void {
  const input = event.currentTarget as HTMLInputElement;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      if (commandMode || shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      select((selected + step + shown.length) % shown.length, true);
      return;
    }
    case "Enter": {
      event.preventDefault();
      if (running) return;
      if (commandMode) void run(commandMode.item, input.value);
      else if (shown[selected]) void activate(shown[selected]!);
      return;
    }
    case "Tab": {
      event.preventDefault();
      const item = shown[selected];
      if (!commandMode && item?.kind === "command" && item.spec.input) enterCommand(item);
      return;
    }
    case "Escape": {
      event.preventDefault();
      if (commandMode && !running) leaveCommand(true);
      else hide();
      return;
    }
    case "Backspace": {
      if (commandMode && !running && input.value === "") {
        event.preventDefault();
        leaveCommand(true);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- actions --

async function activate(item: Item): Promise<void> {
  if (item.kind === "window") {
    hide();
    await os.windows.focus(item.info.windowId).catch(logError);
    return;
  }
  if (item.kind === "result") return run(item, item.input);
  if (item.kind === "command") {
    if (item.spec.input) return enterCommand(item);
    return run(item, "");
  }
  remember(item.key);
  hide();
  if (item.kind === "file") {
    await os.process.spawn(openerOf(item.file), [item.file.path]).catch(logError);
    return;
  }
  await os.process.spawn(item.entry.exec).catch(logError);
}

function enterCommand(item: CommandItem): void {
  const input = $<HTMLInputElement>("query");
  commandMode = { item, query: input.value };
  askApps("");
  input.value = "";
  input.placeholder = item.spec.input?.placeholder ?? item.title;
  $<HTMLImageElement>("chip-icon").src = item.icon;
  $("chip-title").textContent = item.title;
  $("chip").hidden = false;
  setStatus(null);
  render();
  input.focus();
}

/** Back to searching; `restore` puts back what was typed before the command was picked. */
function leaveCommand(restore: boolean): void {
  if (!commandMode) return;
  const input = $<HTMLInputElement>("query");
  input.value = restore ? commandMode.query : "";
  input.placeholder = "Search apps, windows, commands and files";
  commandMode = null;
  $("chip").hidden = true;
  setStatus(null);
  askApps(input.value.trim());
  render();
}

async function run(item: Runnable, text: string): Promise<void> {
  if (item.kind === "command" && item.spec.input?.required && !text.trim()) {
    setStatus({ text: "Type something first.", error: true });
    return;
  }
  setBusy(true);
  setStatus(null);
  let result: CommandResult;
  try {
    result = await execute(item, text);
  } catch (error) {
    logError(error);
    result = { error: `Couldn't run ${item.title}.` };
  } finally {
    setBusy(false);
  }
  if (!visible) return; // put away meanwhile: it ran, there's just no one to tell

  if (result.error) {
    setStatus({ text: result.error, error: true });
    return;
  }
  // A result is about one thing, at one moment: not worth keeping as a recent.
  if (item.kind === "command") remember(item.key);
  setStatus({ text: result.message ?? "Done." });
  $<HTMLInputElement>("query").disabled = true;
  hideTimer = setTimeout(() => {
    hide();
    if (result.open) void os.process.spawn(item.entry.exec, result.open).catch(logError);
  }, DONE_MS);
}

/** Run the command's program; its one JSON line is the result. */
async function execute(item: Runnable, text: string): Promise<CommandResult> {
  const { output, killed } = await capture(item.entry.run!, [item.spec.id, text], COMMAND_TIMEOUT_MS);
  if (killed && !output) return { error: `${item.title} took too long.` };
  return parseResult(output);
}

/**
 * Ask the apps that answer searches what they have for `query`, once typing
 * pauses. Answers for an older query are dropped; each app's are drawn as
 * they come.
 */
function askApps(query: string): void {
  clearTimeout(searchTimer);
  searching = query;
  if (found.length) found = [];
  if (!query) return;
  searchTimer = setTimeout(() => {
    for (const entry of apps.filter((app) => app.search && app.run)) {
      void capture(entry.run!, [SEARCH_FLAG, query], SEARCH_TIMEOUT_MS)
        .then(({ output }) => {
          if (searching !== query || !visible || commandMode) return;
          const results = parseSearch(output).flatMap((result): ResultItem[] => {
            // Only one of its own commands, declared up front.
            const spec = entry.commands?.find((command) => command.id === result.command);
            if (!spec) return [];
            return [
              {
                kind: "result",
                key: `result:${entry.id}/${spec.id}/${result.input ?? ""}`,
                title: result.title,
                also: result.detail ? [result.detail] : [],
                icon: entry.icon,
                entry,
                spec,
                input: result.input ?? "",
                detail: result.detail,
              },
            ];
          });
          found = [...found.filter((item) => item.entry !== entry), ...results];
          render(true);
        })
        .catch(logError);
    }
  }, SEARCH_DELAY_MS);
}

/**
 * Run `run[0]` with `run[1..]` and `args`, stdout into a pipe, and return
 * what it printed. Killed after `timeout`. Its stdout is the only other
 * writer once ours is closed, so its exit is our end of file.
 */
async function capture(
  run: string[],
  args: string[],
  timeout: number,
): Promise<{ output: string; killed: boolean }> {
  const [path, ...before] = run;
  const { read, write } = await os.io.pipe();
  let pid: Pid;
  try {
    pid = await os.process.spawn(path!, [...before, ...args], { fds: { 1: write } });
  } catch (error) {
    await os.io.close(read).catch(() => {});
    throw error;
  } finally {
    await os.io.close(write).catch(() => {});
  }

  const timer = setTimeout(() => void os.process.kill(pid, "SIGKILL").catch(() => {}), timeout);
  try {
    const decoder = new TextDecoder();
    let output = "";
    while (output.length < 16_384) {
      const chunk = await os.io.read(read, 4096);
      if (chunk.length === 0) break;
      output += decoder.decode(chunk, { stream: true });
    }
    const status = await os.process.wait(pid).catch(() => null);
    return { output, killed: status?.reason === "signal" };
  } finally {
    clearTimeout(timer);
    await os.io.close(read).catch(() => {});
  }
}

// --------------------------------------------------------------- recents --

async function loadRecents(): Promise<string[]> {
  try {
    const raw = JSON.parse(await os.fs.readTextFile(recentsFile)) as { recent?: unknown };
    return Array.isArray(raw.recent)
      ? raw.recent.filter((key): key is string => typeof key === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function remember(key: string): void {
  recents = [key, ...recents.filter((other) => other !== key)].slice(0, 20);
  void os.fs
    .writeTextFile(recentsFile, `${JSON.stringify({ recent: recents }, null, 2)}\n`)
    .catch(logError);
}
