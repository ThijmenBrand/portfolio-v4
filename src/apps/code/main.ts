import type { AppInterface } from "../../kernel/syscalls/api";
import type { WindowHandle } from "../../kernel/windows/types";
import type { DirEntry } from "../../kernel/fs/types";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import { errorCode } from "../../bin/lib/input";
import { Terminal } from "../terminal/main";

import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import {
  EditorState,
  Prec,
  type Extension,
  type Text,
} from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

import codeHTML from "./code.html?raw";
import { ensureConfigDir, followAccent } from "../../utils/settings";
import { extOf, IMAGE_TYPES } from "../../utils/filetypes";
import { copyTree, moveTree, removeTree } from "../../utils/tree";
import { freeName } from "../files/names";
import "../../ui/theme.css";
import "./code.css";

const LANGS: Record<string, [name: string, load: () => Extension]> = {
  ts: ["TypeScript", () => javascript({ typescript: true })],
  tsx: ["TypeScript JSX", () => javascript({ typescript: true, jsx: true })],
  js: ["JavaScript", () => javascript()],
  mjs: ["JavaScript", () => javascript()],
  cjs: ["JavaScript", () => javascript()],
  jsx: ["JavaScript JSX", () => javascript({ jsx: true })],
  json: ["JSON", json],
  css: ["CSS", css],
  html: ["HTML", html],
  htm: ["HTML", html],
  md: ["Markdown", markdown],
  py: ["Python", python],
};

/** Explorer/tab badge: [glyph, color]. */
const BADGES: Record<string, [string, string]> = {
  ts: ["TS", "#4d9fff"],
  tsx: ["TS", "#4d9fff"],
  js: ["JS", "#e8c547"],
  mjs: ["JS", "#e8c547"],
  cjs: ["JS", "#e8c547"],
  jsx: ["JS", "#e8c547"],
  json: ["{}", "#e2b95f"],
  css: ["#", "#c678dd"],
  html: ["<>", "#e8744f"],
  htm: ["<>", "#e8744f"],
  md: ["M", "#5ab0c6"],
  py: ["PY", "#6cd39a"],
};

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const PAGE =
  '<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3"/>';
const IMAGE_ICON: [string, string] = [
  svg(
    '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/>',
  ),
  "#c58af9",
];
/** Explorer/tab icon for files without a language badge: [svg, color]. */
const ICONS: Record<string, [string, string]> = {
  ...Object.fromEntries(
    Object.keys(IMAGE_TYPES).map((ext) => [ext, IMAGE_ICON]),
  ),
  sh: [
    svg(
      '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8 10h3.5"/>',
    ),
    "#6cd39a",
  ],
  txt: [svg(`${PAGE}<path d="M5.5 8h5M5.5 10.5h5"/>`), "#9b9ba6"],
  pdf: [svg(`${PAGE}<path d="M5.5 8h5M5.5 10.5h3"/>`), "#ff7676"],
};
const FILE_ICON: [string, string] = [svg(PAGE), "var(--app-text-faint)"];

const IS_MAC = navigator.userAgent.includes("Mac");

interface Tab {
  path: string;
  state: EditorState;
  saved: Text;
  readonly: boolean;
  el: HTMLElement;
}

/** One entry of `.code/launch.json`, VS Code's launch.json made small. */
interface LaunchConfig {
  name?: string;
  /** Relative to the explorer root, or absolute. */
  program: string;
  /** e.g. "/ProgramFiles/sh". Omitted: run the file itself (needs `#!`). */
  interpreter?: string;
  args?: string[];
}

const LAUNCH_FILE = ".code/launch.json";

type View = "explorer" | "search" | "run";

const SEARCH_SKIP = new Set([".git", "node_modules", "dist"]);
const SEARCH_LIMIT = 2000;

/** Quick Open: files indexed per folder, and rows shown per query. */
const INDEX_LIMIT = 5000;
const PALETTE_LIMIT = 50;

/**
 * Drag payloads. `dataTransfer.getData` is blocked until the drop, but
 * `types` is readable during dragover, so the type alone says "this is ours"
 * and the dragged path is kept in a field.
 */
const DRAG_PATH = "application/x-code-path";
const DRAG_TAB = "application/x-code-tab";

/** How long a drag has to rest on a closed folder before it springs open. */
const SPRING_MS = 650;

const PLAY_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.5.5 0 0 0 .77.42l8-5.2a.5.5 0 0 0 0-.84l-8-5.2a.5.5 0 0 0-.77.42z" /></svg>';

/** Single-quotes a shell word when needed; sh has no escapes inside '...'. */
const quote = (word: string): string =>
  /^[\w./=:+-]+$/.test(word) ? word : `'${word}'`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One subsequence pass from `from`; characters at or past `base` score more. */
function subsequence(
  hay: string,
  query: string,
  from: number,
  base: number,
): number | null {
  let at = from;
  let points = 0;
  for (const ch of query) {
    const i = hay.indexOf(ch, at);
    if (i < 0) return null;
    points += (i === at ? 6 : 0) + (i >= base ? 4 : 0) - Math.min(i - at, 8);
    at = i + 1;
  }
  return points;
}

/**
 * Quick Open ranking: every query character must appear in order. Runs of
 * adjacent characters and hits in the file name beat hits in the folders,
 * and a shorter path breaks the tie. `null` means no match.
 *
 * Greedy matching can be led astray by a stray letter in a folder name
 * ("main" finding the m of "terminal"), so the file name gets its own pass
 * and the better of the two wins.
 */
function score(path: string, query: string): number | null {
  const hay = path.toLowerCase();
  const base = path.lastIndexOf("/") + 1;
  const best = Math.max(
    subsequence(hay, query, 0, base) ?? -Infinity,
    (base > 0 ? subsequence(hay, query, base, base) : null) ?? -Infinity,
  );
  return best === -Infinity ? null : best - path.length / 40;
}

/** New file/folder name being typed inline in the tree. */
interface Pending {
  dir: string;
  kind: "file" | "directory";
}

/** One context-menu entry; `null` in a list is a separator. */
interface MenuEntry {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** `path` is `root` or inside it. */
const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string): string =>
  p.slice(0, Math.max(p.lastIndexOf("/"), 1));
const join = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

function resolve(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const seg of (path.startsWith("/") ? path : `${cwd}/${path}`).split(
    "/",
  )) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function badge(path: string): HTMLElement {
  const ext = extOf(path);
  const text = BADGES[ext];
  const node = el("span", "code-badge", text?.[0]);
  const [icon, color] = text ? ["", text[1]] : (ICONS[ext] ?? FILE_ICON);
  if (icon) node.innerHTML = icon;
  node.style.color = color;
  return node;
}

class Editor {
  private readonly os: AppInterface;
  private readonly win: WindowHandle;
  private readonly root: HTMLElement;
  private readonly field = <T extends HTMLElement = HTMLElement>(
    name: string,
  ): T => selectElementFromTemplate<T>(this.root, `[data-field="${name}"]`);

  private readonly tree: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly editorHost: HTMLElement;
  private readonly status: Record<
    "msg" | "cursor" | "indent" | "enc" | "lang",
    HTMLElement
  >;
  private readonly view: EditorView;
  private readonly shared: Extension;

  private rootDir: string | null = null;
  private selectedDir = "/";
  private readonly expanded = new Set<string>();
  private pending: Pending | null = null;
  /** Path whose name is being edited inline in the tree. */
  private renaming: string | null = null;
  private clipboard: { path: string; cut: boolean } | null = null;
  private readonly menu: HTMLElement;
  /** The explorer row being dragged, while a drag is in flight. */
  private drag: { path: string; dir: boolean; readonly: boolean } | null = null;
  /** The tab being dragged, while a tab reorder is in flight. */
  private dragTab: string | null = null;
  /** Folder the current drop would land in; drives the highlight and spring. */
  private dropDir: string | null = null;
  private springTimer = 0;
  private palette: { el: HTMLElement; close: () => void } | null = null;

  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private title = "";
  private flashTimer = 0;
  private terminal: Terminal | null = null;
  private launch: LaunchConfig[] = [];
  private sidebarView: View = "explorer";
  /** Bumped per query so a slow, stale search stops rendering. */
  private searchRun = 0;
  private searchTimer = 0;

  public constructor(os: AppInterface, win: WindowHandle) {
    this.os = os;
    this.win = win;
    this.root = htmlStringToTemplate(codeHTML);
    document.body.appendChild(this.root);

    this.tree = this.field("tree");
    this.tabsEl = this.field("tabs");
    this.crumbs = this.field("crumbs");
    this.editorHost = this.field("editor");
    this.status = {
      msg: this.field("status-msg"),
      cursor: this.field("status-cursor"),
      indent: this.field("status-indent"),
      enc: this.field("status-enc"),
      lang: this.field("status-lang"),
    };
    for (const kbd of this.root.querySelectorAll("kbd[data-mod]")) {
      kbd.textContent = IS_MAC ? "⌘" : "Ctrl";
    }

    this.shared = [
      basicSetup,
      // basicSetup leaves Tab alone so it can still move focus; a code editor
      // wants it to indent, and Ctrl-m (Shift-Alt-m on Mac) frees it again.
      keymap.of([indentWithTab]),
      oneDark,
      Prec.highest(
        EditorView.theme(
          {
            "&": {
              height: "100%",
              backgroundColor: "var(--app-well)",
              fontSize: "13.5px",
            },
            ".cm-scroller": {
              fontFamily: "var(--app-mono)",
              lineHeight: "1.6",
            },
            ".cm-gutters": {
              backgroundColor: "var(--app-well)",
              border: "none",
              color: "var(--app-text-faint)",
            },
            ".cm-activeLineGutter": {
              backgroundColor: "transparent",
              color: "var(--app-text)",
            },
            ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.035)" },
            ".cm-content": { caretColor: "var(--app-accent)" },
            ".cm-cursor": {
              borderLeftColor: "var(--app-accent)",
              borderLeftWidth: "2px",
            },
          },
          { dark: true },
        ),
      ),
      EditorView.updateListener.of((u) => this.onUpdate(u)),
    ];
    this.view = new EditorView({ parent: this.editorHost });
    this.menu = el("div", "code-menu");
    this.menu.setAttribute("role", "menu");
    this.menu.hidden = true;
    this.root.append(this.menu);

    void win.onCloseRequest(() => void this.quit());
    this.bindChrome();
  }

  public async start(args: string[]): Promise<void> {
    const [arg] = args;
    if (arg === undefined) {
      this.showWelcome();
      const dir = await this.os.fs
        .readTextFile(`${await ensureConfigDir(this.os)}/code-folder`)
        .catch(() => "");
      const ok =
        dir !== "" &&
        (await this.os.fs.stat(dir).then(
          (s) => s.kind === "directory",
          () => false,
        ));
      return ok ? this.openFolder(dir) : this.renderTree();
    }
    const path = resolve(await this.os.process.cwd(), arg);
    let isDir = false;
    try {
      isDir = (await this.os.fs.stat(path)).kind === "directory";
    } catch {
      // Missing: open() shows an empty buffer and saving creates it.
    }
    if (isDir) {
      this.showWelcome();
      return this.openFolder(path);
    }
    await this.open(path, false);
    // Welcome only if the open failed; showing it up front flashes before the file loads.
    if (!this.active) this.showWelcome();
    await this.renderTree();
  }

  private async openFolder(dir: string): Promise<void> {
    this.rootDir = dir;
    this.selectedDir = dir;
    this.expanded.clear();
    this.pending = null;
    this.field("root-name").textContent = basename(dir) || "/";
    this.root.classList.remove("no-folder");
    // Reopened on the next start without arguments.
    void ensureConfigDir(this.os)
      .then((config) => this.os.fs.writeTextFile(`${config}/code-folder`, dir))
      .catch(() => {});
    await this.renderTree();
  }

  private async promptOpenFolder(): Promise<void> {
    let dir: string | null;
    try {
      dir = await this.os.dialog.open({
        kind: "directory",
        startIn: this.rootDir ?? undefined,
      });
    } catch (error) {
      return this.flash(`Couldn't open folder (${errorCode(error)})`, true);
    }
    if (dir !== null) await this.openFolder(dir);
  }

  // ---- chrome -------------------------------------------------------------

  private bindChrome(): void {
    this.field("explorer-btn").addEventListener("click", () =>
      this.showView("explorer"),
    );
    this.field("run-btn").addEventListener("click", () => this.showView("run"));
    this.field("search-btn").addEventListener("click", () => this.openSearch());
    const searchInput = this.field<HTMLInputElement>("search-input");
    searchInput.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(
        () => void this.search(searchInput.value),
        200,
      );
    });
    this.field("config-add").addEventListener(
      "click",
      () => void this.startConfig(),
    );
    this.field("config-open").addEventListener("click", () => {
      if (this.rootDir === null) return this.flash("Open a folder first");
      void this.open(join(this.rootDir, LAUNCH_FILE), false);
    });
    for (const name of ["open-folder", "welcome-open"])
      this.field(name).addEventListener(
        "click",
        () => void this.promptOpenFolder(),
      );
    this.field("config-cancel").addEventListener("click", () => {
      this.field("config-form").hidden = true;
    });
    const form = this.field<HTMLFormElement>("config-form");
    // ponytail: no submit event; the realm sandbox lacks allow-forms, so
    // the browser blocks form submission outright. Click and Enter instead.
    const submit = (): void => {
      if (!form.reportValidity()) return;
      void this.addConfig(new FormData(form));
    };
    this.field("config-submit").addEventListener("click", submit);
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        form.hidden = true;
      }
    });
    this.field("root-btn").addEventListener("click", () => {
      this.selectedDir = this.rootDir ?? "/";
      this.highlight();
    });
    this.field("new-file").addEventListener(
      "click",
      () => void this.startCreate("file"),
    );
    this.field("new-folder").addEventListener(
      "click",
      () => void this.startCreate("directory"),
    );
    this.field("refresh").addEventListener(
      "click",
      () => void this.renderTree(),
    );
    this.field("terminal-btn").addEventListener(
      "click",
      () => void this.toggleTerminal(),
    );
    this.field("run").addEventListener(
      "click",
      () => void (this.active && this.run(this.active.path)),
    );
    this.field("panel-close").addEventListener(
      "click",
      () => void this.toggleTerminal(false),
    );
    this.field("collapse").addEventListener("click", () => {
      this.expanded.clear();
      void this.renderTree();
    });
    this.bindMenu();
    this.bindDrag();

    // The tab strip only scrolls sideways; a plain wheel should still move it.
    this.tabsEl.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaX !== 0 || e.deltaY === 0) return;
        e.preventDefault();
        this.tabsEl.scrollLeft += e.deltaY;
      },
      { passive: false },
    );

    // Capture phase: beats CodeMirror and the browser's own Save dialog.
    window.addEventListener(
      "keydown",
      (e) => {
        const mod = IS_MAC ? e.metaKey : e.ctrlKey;
        let handled = true;
        if (mod && e.shiftKey && e.code === "KeyF") this.openSearch();
        else if (mod && e.code === "KeyP") void this.openPalette();
        else if (mod && e.code === "KeyS")
          void (this.active && this.save(this.active));
        else if (mod && e.code === "KeyB") this.toggleSidebar();
        else if (mod && e.code === "KeyO") void this.promptOpenFolder();
        // Ctrl on every platform, like VS Code.
        else if (e.ctrlKey && e.code === "Backquote")
          void this.toggleTerminal();
        // ponytail: Alt+W, since browsers never hand Ctrl/Cmd+W to the page.
        else if (e.altKey && e.code === "KeyW")
          void (this.active && this.closeTab(this.active));
        else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );

    const resizer = this.field("resizer");
    resizer.addEventListener("pointerdown", (down) => {
      const sidebar = this.root.querySelector<HTMLElement>(".code-sidebar");
      if (!sidebar) return;
      const startX = down.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      resizer.setPointerCapture(down.pointerId);
      resizer.classList.add("dragging");
      const move = (e: PointerEvent): void => {
        const width = Math.min(420, Math.max(160, startW + e.clientX - startX));
        this.root.style.setProperty("--code-sidebar", `${width}px`);
      };
      const up = (): void => {
        resizer.classList.remove("dragging");
        resizer.removeEventListener("pointermove", move);
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up, { once: true });
    });
  }

  /** Shows `view` in the sidebar, opening the sidebar when it is hidden. */
  private ensureView(view: View): void {
    if (this.root.classList.contains("no-sidebar") || this.sidebarView !== view)
      this.showView(view);
  }

  private toggleSidebar(): void {
    const hidden = this.root.classList.toggle("no-sidebar");
    this.field(`${this.sidebarView}-btn`).classList.toggle("active", !hidden);
  }

  /** Like VS Code: clicking the open view's icon hides the sidebar. */
  private showView(view: View): void {
    const hidden = this.root.classList.contains("no-sidebar");
    if (!hidden && view === this.sidebarView) return this.toggleSidebar();
    this.field(`${this.sidebarView}-btn`).classList.remove("active");
    this.sidebarView = view;
    this.field("explorer-view").hidden = view !== "explorer";
    this.field("run-view").hidden = view !== "run";
    this.field("search-view").hidden = view !== "search";
    if (hidden) this.toggleSidebar();
    else this.field(`${view}-btn`).classList.add("active");
  }

  /** The shell starts on first open and lives on while the panel is hidden. */
  private async toggleTerminal(
    show = this.field("panel").hidden === true,
  ): Promise<void> {
    const panel = this.field("panel");
    panel.hidden = !show;
    this.field("terminal-btn").classList.toggle("active", show);
    if (!show) {
      if (this.active) this.view.focus();
      return;
    }
    if (this.terminal) return this.terminal.focus();

    const terminal = new Terminal(this.os, panel, () => {
      // `exit` closes the panel; the next open gets a fresh shell.
      terminal.dispose();
      panel.querySelector(".term")?.remove();
      if (this.terminal === terminal) this.terminal = null;
      void this.toggleTerminal(false);
    });
    this.terminal = terminal;
    try {
      // The shell inherits our cwd: start it in the explorer's root.
      if (this.rootDir !== null) await this.os.process.chdir(this.rootDir);
      await terminal.start();
    } catch (error) {
      this.flash(`Couldn't start terminal (${errorCode(error)})`, true);
    }
  }

  private configFor(path: string | undefined): LaunchConfig | undefined {
    const root = this.rootDir;
    if (root === null) return undefined;
    return this.launch.find((c) => resolve(root, c.program) === path);
  }

  /**
   * A launch config wins; otherwise an open file whose first line is `#!`
   * is runnable, like Linux.
   */
  private commandFor(
    path: string,
    config = this.configFor(path),
  ): string | null {
    if (config) {
      return [config.interpreter, path, ...(config.args ?? [])]
        .filter((part) => part !== undefined)
        .map(quote)
        .join(" ");
    }
    const tab = this.tabs.find((t) => t.path === path);
    return tab?.state.doc.line(1).text.startsWith("#!") ? quote(path) : null;
  }

  private updateRun(): void {
    const run = this.field("run");
    const config = this.configFor(this.active?.path);
    run.hidden = !this.active || this.commandFor(this.active.path) === null;
    run.title = config
      ? `Run '${config.name ?? basename(config.program)}'`
      : "Run File";
  }

  /** `<root>/.code/launch.json`, re-read on every tree render (save, refresh). */
  private async loadLaunch(): Promise<void> {
    if (this.rootDir === null) {
      this.launch = [];
      this.updateRun();
      return this.renderConfigs();
    }
    const path = join(this.rootDir, LAUNCH_FILE);
    try {
      const parsed = JSON.parse(await this.os.fs.readTextFile(path)) as {
        configurations?: unknown;
      };
      if (!Array.isArray(parsed.configurations))
        throw new Error("no configurations");
      this.launch = (parsed.configurations as LaunchConfig[]).filter(
        (c) => typeof c?.program === "string",
      );
    } catch (error) {
      this.launch = [];
      if (errorCode(error) !== "ENOENT")
        this.flash(`${LAUNCH_FILE}: ${message(error)}`, true);
    }
    this.updateRun();
    this.renderConfigs();
  }

  private async writeLaunch(configurations: LaunchConfig[]): Promise<void> {
    if (this.rootDir === null) return this.flash("Open a folder first");
    const path = join(this.rootDir, LAUNCH_FILE);
    const text = `${JSON.stringify({ configurations }, null, 2)}\n`;
    try {
      await this.os.fs.mkdir(dirname(path)).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      await this.os.fs.writeTextFile(path, text);
    } catch (error) {
      this.flash(`Couldn't save ${LAUNCH_FILE} (${errorCode(error)})`, true);
      return;
    }

    // An open, unedited launch.json follows along; an edited one is left alone.
    const tab = this.tabs.find((t) => t.path === path);
    if (tab && !this.isDirty(tab)) {
      const tr = tab.state.update({
        changes: { from: 0, to: tab.state.doc.length, insert: text },
      });
      if (tab === this.active) this.view.dispatch(tr);
      else tab.state = tr.state;
      tab.saved = tab.state.doc;
      tab.el.classList.remove("dirty");
      this.updateTitle();
    }
    await this.renderTree();
  }

  private renderConfigs(): void {
    const list = this.field("configs");
    const root = this.rootDir;
    if (root === null) {
      const open = el("button", "code-btn primary", "Open Folder");
      open.addEventListener("click", () => void this.promptOpenFolder());
      list.replaceChildren(
        el(
          "div",
          "code-tree-note",
          "Open a folder to add launch configurations.",
        ),
        open,
      );
      return;
    }
    if (this.launch.length === 0) {
      const add = el("button", "code-btn primary", "Add Configuration");
      add.addEventListener("click", () => void this.startConfig());
      list.replaceChildren(
        el("div", "code-tree-note", "No launch configurations yet."),
        add,
      );
      return;
    }

    list.replaceChildren(
      ...this.launch.map((config, i) => {
        const path = resolve(root, config.program);
        const row = el("div", "code-row");
        row.style.paddingLeft = "6px";
        row.title = this.commandFor(path, config) ?? path;

        const play = el("button", "code-icon-btn code-config-play");
        play.innerHTML = PLAY_SVG;
        play.title = "Run";
        play.setAttribute("aria-label", `Run ${config.name ?? config.program}`);
        play.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.run(path, config);
        });

        const del = el("button", "code-icon-btn code-row-del", "×");
        del.title = "Remove Configuration";
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.writeLaunch(this.launch.filter((_, j) => j !== i));
        });

        row.addEventListener("click", () => void this.open(path));
        row.append(
          play,
          el("span", "code-row-name", config.name ?? basename(config.program)),
          el(
            "span",
            "code-config-detail",
            config.interpreter ? basename(config.interpreter) : "#!",
          ),
          del,
        );
        return row;
      }),
    );
  }

  /** Opens the add form, prefilled for the active file. */
  private async startConfig(): Promise<void> {
    const root = this.rootDir;
    if (root === null) return this.flash("Open a folder first");
    this.ensureView("run");
    const form = this.field<HTMLFormElement>("config-form");
    form.reset();

    let programs: string[] = [];
    try {
      programs = (await this.os.fs.readdir("/ProgramFiles")).map(
        (e) => `/ProgramFiles/${e.name}`,
      );
    } catch {
      // No list: "run directly" still works.
    }
    const path = this.active?.path;
    const shebang =
      path !== undefined && this.commandFor(path, undefined) !== null;
    const select = form.elements.namedItem("interpreter") as HTMLSelectElement;
    select.replaceChildren(
      new Option("Run directly (#!)", "", false, shebang),
      ...programs.map(
        (p) => new Option(p, p, false, !shebang && p === "/ProgramFiles/sh"),
      ),
    );

    const program = form.elements.namedItem("program") as HTMLInputElement;
    if (path) {
      program.value = path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : path;
    }
    form.hidden = false;
    (form.elements.namedItem("name") as HTMLInputElement).focus();
  }

  private async addConfig(data: FormData): Promise<void> {
    const get = (key: string): string => String(data.get(key) ?? "").trim();
    const config: LaunchConfig = { program: get("program") };
    if (get("name")) config.name = get("name");
    if (get("interpreter")) config.interpreter = get("interpreter");
    const args = get("args").split(/\s+/).filter(Boolean);
    if (args.length > 0) config.args = args;

    this.field("config-form").hidden = true;
    // name first in the file, like VS Code's snippets.
    const { name, ...rest } = config;
    await this.writeLaunch([...this.launch, name ? { name, ...rest } : rest]);
  }

  private async run(path: string, config?: LaunchConfig): Promise<void> {
    const tab = this.tabs.find((t) => t.path === path);
    if (tab && this.isDirty(tab) && !(await this.save(tab))) return;
    const command = this.commandFor(path, config);
    if (command === null) return;
    await this.toggleTerminal(true);
    await this.terminal?.run(command);
  }

  private flash(message: string, error = false): void {
    this.status.msg.textContent = message;
    this.status.msg.classList.toggle("error", error);
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.updateStatus(), 3500);
  }

  private dialog(
    message: string,
    detail: string,
    buttons: string[],
  ): Promise<string | null> {
    return new Promise((done) => {
      const backdrop = el("div", "code-modal-backdrop");
      const box = el("div", "code-modal");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      const actions = el("div", "code-modal-actions");
      const finish = (choice: string | null): void => {
        backdrop.remove();
        done(choice);
        if (this.active) this.view.focus();
      };
      buttons.forEach((label, i) => {
        const btn = el(
          "button",
          i === 0 ? "code-btn primary" : "code-btn",
          label,
        );
        btn.addEventListener("click", () => finish(label));
        actions.append(btn);
      });
      backdrop.addEventListener("keydown", (e) => {
        if (e.key === "Escape") finish(null);
      });
      backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) finish(null);
      });
      box.append(
        el("p", "code-modal-msg", message),
        el("p", "code-modal-detail", detail),
        actions,
      );
      backdrop.append(box);
      this.root.append(backdrop);
      (actions.firstElementChild as HTMLElement).focus();
    });
  }

  // ---- search -------------------------------------------------------------

  /** Opens the search view (never toggles it closed) and focuses the query. */
  private openSearch(): void {
    this.ensureView("search");
    const input = this.field<HTMLInputElement>("search-input");
    const selected = this.active
      ? this.view.state.sliceDoc(
          this.view.state.selection.main.from,
          this.view.state.selection.main.to,
        )
      : "";
    if (selected && !selected.includes("\n")) {
      input.value = selected;
      void this.search(selected);
    }
    input.focus();
    input.select();
  }

  /** Case-insensitive substring search over every text file under the root. */
  private async search(query: string): Promise<void> {
    const run = ++this.searchRun;
    const list = this.field("search-results");
    const root = this.rootDir;
    if (query === "") return list.replaceChildren();
    if (root === null)
      return list.replaceChildren(
        el("div", "code-tree-note", "Open a folder to search in it."),
      );

    const needle = query.toLowerCase();
    const rows = document.createDocumentFragment();
    let matches = 0;
    let files = 0;
    // ponytail: walks and reads the whole folder per query; an index if folders get big.
    const walk = async (dir: string): Promise<void> => {
      let entries: DirEntry[];
      try {
        entries = await this.os.fs.readdir(dir);
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (run !== this.searchRun || matches >= SEARCH_LIMIT) return;
        const path = join(dir, entry.name);
        if (entry.kind === "directory") {
          if (!SEARCH_SKIP.has(entry.name)) await walk(path);
          continue;
        }
        const text = await this.textOf(path);
        if (text === null) continue;
        const hits = this.searchFile(path, text, needle, query.length);
        if (hits.length === 0) continue;
        files++;
        matches += hits.length - 1;
        const head = el("div", "code-row");
        head.style.paddingLeft = "6px";
        head.title = path;
        head.append(
          badge(path),
          el("span", "code-row-name", path.slice(root.length + 1) || path),
          el("span", "code-config-detail", String(hits.length - 1)),
        );
        head.addEventListener("click", () => void this.open(path));
        rows.append(...hits.map((h, i) => (i === 0 ? head : h)));
      }
    };
    await walk(root);
    if (run !== this.searchRun) return;
    const summary =
      matches === 0
        ? "No results found."
        : `${matches}${matches >= SEARCH_LIMIT ? "+" : ""} result${matches === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
    list.replaceChildren(el("div", "code-tree-note", summary), rows);
  }

  /** An open tab's live buffer wins over disk; binary files are skipped. */
  private async textOf(path: string): Promise<string | null> {
    const tab = this.tabs.find((t) => t.path === path);
    if (tab) return tab.state.doc.toString();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await this.os.fs.readFile(path),
      );
      return text.includes("\0") ? null : text;
    } catch {
      return null;
    }
  }

  /** Match rows for one file, with a placeholder at [0] for its header. */
  private searchFile(
    path: string,
    text: string,
    needle: string,
    length: number,
  ): HTMLElement[] {
    const rows: HTMLElement[] = [el("div")];
    text.split("\n").forEach((line, i) => {
      const col = line.toLowerCase().indexOf(needle);
      if (col < 0) return;
      const row = el("div", "code-row code-search-line");
      row.style.paddingLeft = "24px";
      // Trim long leading context so the match stays visible.
      const start = Math.max(0, col - 20);
      const name = el("span", "code-row-name");
      name.append(
        (start > 0 ? "…" : "") + line.slice(start, col).trimStart(),
        el("mark", "", line.slice(col, col + length)),
        line.slice(col + length, col + length + 200),
      );
      row.title = `${path}:${i + 1}`;
      row.append(name);
      row.addEventListener(
        "click",
        () => void this.reveal(path, i + 1, col, length),
      );
      rows.push(row);
    });
    return rows;
  }

  private async reveal(
    path: string,
    line: number,
    col: number,
    length: number,
  ): Promise<void> {
    await this.open(path);
    if (this.active?.path !== path) return;
    const doc = this.view.state.doc;
    if (line > doc.lines) return;
    const from = Math.min(doc.line(line).from + col, doc.length);
    this.view.dispatch({
      selection: { anchor: from, head: Math.min(from + length, doc.length) },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  // ---- context menu -------------------------------------------------------

  private bindMenu(): void {
    this.tree.addEventListener("contextmenu", (e) => {
      if (this.rootDir === null) return;
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>(
        ".code-row[data-path]",
      );
      const path = row?.dataset.path;
      const isDir = row ? row.dataset.dir === "true" : true;
      // New items and pastes land in the folder that was clicked (or holds the file).
      const dir =
        path === undefined ? this.rootDir : isDir ? path : dirname(path);
      this.selectedDir = dir;
      this.highlight();
      this.openMenu(e.clientX, e.clientY, [
        { label: "New File…", action: () => void this.startCreate("file") },
        {
          label: "New Folder…",
          action: () => void this.startCreate("directory"),
        },
        null,
        ...(path === undefined
          ? []
          : this.itemMenu(path, row?.dataset.readonly === "true")),
        {
          label: "Paste",
          action: () => void this.paste(dir),
          disabled: !this.clipboard,
        },
      ]);
    });
    this.menu.addEventListener("keydown", (e) => {
      const buttons = [
        ...this.menu.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      ];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = { ArrowDown: at + 1, ArrowUp: at - 1 }[e.key];
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        this.closeMenu();
      } else if (next !== undefined) {
        e.preventDefault();
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.contains(e.target as Node)) this.closeMenu();
    });
    window.addEventListener("blur", () => this.closeMenu());
  }

  private itemMenu(path: string, readonly: boolean): (MenuEntry | null)[] {
    const root = this.rootDir ?? "/";
    const isRoot = path === root;
    const copyText = (text: string): void =>
      void this.os.clipboard
        .writeText(text)
        .catch(() => this.flash("Couldn't copy to clipboard", true));
    return [
      {
        label: "Cut",
        action: () => this.setClipboard(path, true),
        disabled: readonly,
      },
      { label: "Copy", action: () => this.setClipboard(path, false) },
      null,
      { label: "Copy Path", action: () => copyText(path) },
      {
        label: "Copy Relative Path",
        action: () =>
          copyText(
            isRoot ? "." : path.slice(root === "/" ? 1 : root.length + 1),
          ),
      },
      null,
      {
        label: "Rename…",
        action: () => {
          this.renaming = path;
          void this.renderTree();
        },
        disabled: readonly || isRoot,
      },
      {
        label: "Delete",
        action: () => void this.remove(path),
        disabled: readonly || isRoot,
        danger: true,
      },
      null,
    ];
  }

  private openMenu(x: number, y: number, entries: (MenuEntry | null)[]): void {
    // Drop separators that would sit at an edge or next to another.
    const tidy = entries.filter(
      (entry, i) =>
        entry || (i > 0 && i < entries.length - 1 && entries[i - 1]),
    );
    this.menu.replaceChildren(
      ...tidy.map((entry) => {
        if (!entry) return el("div", "code-menu-sep");
        const button = el(
          "button",
          `code-menu-item${entry.danger ? " danger" : ""}`,
          entry.label,
        );
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.disabled = !!entry.disabled;
        button.addEventListener("click", () => {
          this.closeMenu();
          entry.action();
        });
        return button;
      }),
    );
    this.menu.hidden = false;
    this.menu.style.left = `${Math.min(x, innerWidth - this.menu.offsetWidth - 4)}px`;
    this.menu.style.top = `${Math.min(y, innerHeight - this.menu.offsetHeight - 4)}px`;
    this.menu
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }

  private closeMenu(): void {
    this.menu.hidden = true;
  }

  private setClipboard(path: string, cut: boolean): void {
    this.clipboard = { path, cut };
    this.flash(`${cut ? "Cut" : "Copied"} ${basename(path)}`);
    this.highlight();
  }

  private async paste(dir: string): Promise<void> {
    const clip = this.clipboard;
    if (!clip) return;
    if (isInside(dir, clip.path)) {
      return this.flash("A folder can't be pasted into itself", true);
    }
    if (clip.cut && dirname(clip.path) === dir) {
      this.clipboard = null;
      return this.renderTree();
    }
    try {
      const taken = new Set((await this.os.fs.readdir(dir)).map((e) => e.name));
      const to = join(dir, freeName(basename(clip.path), taken));
      if (clip.cut) {
        await moveTree(this.os, clip.path, to);
        this.moved(clip.path, to);
        this.clipboard = null;
      } else {
        await copyTree(this.os, clip.path, to);
      }
      if (dir !== this.rootDir) this.expanded.add(dir);
    } catch (error) {
      this.flash(
        `Couldn't paste ${basename(clip.path)} (${errorCode(error)})`,
        true,
      );
    }
    await this.renderTree();
  }

  private async rename(path: string, name: string): Promise<void> {
    this.renaming = null;
    if (name === basename(path)) return this.renderTree();
    if (name.includes("/") || name === "." || name === "..") {
      this.flash(`"${name}" is not a valid name`, true);
      return this.renderTree();
    }
    const to = join(dirname(path), name);
    try {
      // moveTree would happily overwrite; refuse like VS Code does.
      if (
        await this.os.fs.stat(to).then(
          () => true,
          () => false,
        )
      )
        throw Object.assign(new Error(), { code: "EEXIST" });
      await moveTree(this.os, path, to);
      this.moved(path, to);
    } catch (error) {
      this.flash(
        `Couldn't rename ${basename(path)} (${errorCode(error)})`,
        true,
      );
    }
    await this.renderTree();
  }

  /** After a move/rename: open tabs, expanded folders and selection follow along. */
  private moved(from: string, to: string): void {
    const remap = (p: string): string =>
      isInside(p, from) ? to + p.slice(from.length) : p;
    for (const tab of this.tabs) {
      if (!isInside(tab.path, from)) continue;
      tab.path = remap(tab.path);
      // Rebuilt, since its handlers close over the old path.
      const node = this.tabEl(tab.path);
      node.className = tab.el.className;
      node.setAttribute("aria-selected", String(tab === this.active));
      tab.el.replaceWith(node);
      tab.el = node;
      if (tab === this.active) {
        this.renderCrumbs();
        this.updateTitle();
      }
    }
    const expanded = [...this.expanded].map(remap);
    this.expanded.clear();
    for (const p of expanded) this.expanded.add(p);
    this.selectedDir = remap(this.selectedDir);
  }

  // ---- drag and drop ------------------------------------------------------

  private bindDrag(): void {
    // The tree, the root header and the editor are all drop targets; a drop on
    // a file row lands in the folder that holds it, like VS Code.
    this.bindDropTarget(this.tree, (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(
        ".code-row[data-path]",
      );
      const path = row?.dataset.path;
      if (path === undefined) return this.rootDir;
      return row?.dataset.dir === "true" ? path : dirname(path);
    });
    this.bindDropTarget(this.field("root-btn"), () => this.rootDir);

    // Dropping a file on the tabs or the editor opens it. The editor listens
    // in the capture phase and stops the event there, so CodeMirror never sees
    // the drop and pastes the dragged path into the buffer.
    for (const node of [this.tabsEl, this.editorHost]) {
      const capture = node === this.editorHost;
      const opens = (e: DragEvent): boolean => {
        if (!e.dataTransfer?.types.includes(DRAG_PATH)) return false;
        if (this.drag?.dir !== false) return false;
        e.preventDefault();
        if (capture) e.stopPropagation();
        return true;
      };
      node.addEventListener(
        "dragover",
        (e) => {
          if (opens(e)) e.dataTransfer!.dropEffect = "link";
        },
        capture,
      );
      node.addEventListener(
        "drop",
        (e) => {
          const path = this.drag?.path;
          if (!opens(e) || path === undefined) return;
          // stopPropagation above keeps the document cleanup from running.
          this.endDrag();
          void this.open(path);
        },
        capture,
      );
    }

    this.bindTabDrag();

    // A spring-loaded folder re-renders the tree mid-drag, so the dragged row
    // can be gone by the time its own dragend would fire. Clean up globally.
    for (const type of ["dragend", "drop"] as const)
      document.addEventListener(type, () => this.endDrag());
  }

  /** Clears every trace of a finished drag, however it ended. */
  private endDrag(): void {
    this.drag = null;
    this.dragTab = null;
    this.clearDrop();
    for (const node of this.root.querySelectorAll(".dragging"))
      node.classList.remove("dragging");
  }

  /** Marks one explorer row as a drag source. */
  private makeDraggable(
    row: HTMLElement,
    path: string,
    dir: boolean,
    readonly: boolean,
  ): void {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      this.drag = { path, dir, readonly };
      if (e.dataTransfer === null) return;
      e.dataTransfer.setData(DRAG_PATH, path);
      // Dropping outside the app (the terminal, a text field) pastes the path.
      e.dataTransfer.setData("text/plain", path);
      // "all": move and copy into the tree, link onto the tabs and the editor.
      e.dataTransfer.effectAllowed = "all";
      row.classList.add("dragging");
    });
  }

  /** A folder is a valid drop unless the move would be a no-op or a cycle. */
  private canDrop(dir: string | null, copy: boolean): dir is string {
    const from = this.drag?.path;
    if (dir === null || from === undefined) return false;
    if (isInside(dir, from)) return false;
    return copy || dirname(from) !== dir;
  }

  /** Alt copies instead of moving, and a read-only source can only be copied. */
  private isCopy(e: DragEvent): boolean {
    return e.altKey || this.drag?.readonly === true;
  }

  private bindDropTarget(
    node: HTMLElement,
    dirFor: (e: DragEvent) => string | null,
  ): void {
    node.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_PATH)) return;
      const dir = dirFor(e);
      if (!this.canDrop(dir, this.isCopy(e))) return this.clearDrop();
      e.preventDefault();
      e.dataTransfer.dropEffect = this.isCopy(e) ? "copy" : "move";
      this.markDrop(dir, node === this.tree ? null : node);
    });
    node.addEventListener("dragleave", (e) => {
      if (!node.contains(e.relatedTarget as Node)) this.clearDrop();
    });
    node.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_PATH)) return;
      const dir = dirFor(e);
      const copy = this.isCopy(e);
      const from = this.drag?.path;
      this.clearDrop();
      if (!this.canDrop(dir, copy) || from === undefined) return;
      e.preventDefault();
      void this.dropInto(from, dir, copy);
    });
  }

  /** Lights up the receiving folder and arms the spring-loaded open. */
  private markDrop(dir: string, node: HTMLElement | null): void {
    for (const row of this.root.querySelectorAll(".drop-into"))
      row.classList.remove("drop-into");
    const row =
      node ??
      this.tree.querySelector<HTMLElement>(
        `.code-row[data-path="${CSS.escape(dir)}"]`,
      );
    (row ?? this.tree).classList.add("drop-into");
    if (dir === this.dropDir) return;
    this.dropDir = dir;
    clearTimeout(this.springTimer);
    // Resting on a closed folder opens it, so you can drop into a deep path.
    if (row !== null && row !== node && !this.expanded.has(dir)) {
      this.springTimer = window.setTimeout(() => {
        this.expanded.add(dir);
        void this.renderTree();
      }, SPRING_MS);
    }
  }

  private clearDrop(): void {
    clearTimeout(this.springTimer);
    this.dropDir = null;
    for (const row of this.root.querySelectorAll(".drop-into"))
      row.classList.remove("drop-into");
    this.tree.classList.remove("drop-into");
  }

  private async dropInto(
    from: string,
    dir: string,
    copy: boolean,
  ): Promise<void> {
    try {
      const taken = new Set((await this.os.fs.readdir(dir)).map((e) => e.name));
      const to = join(dir, freeName(basename(from), taken));
      if (copy) {
        await copyTree(this.os, from, to);
      } else {
        await moveTree(this.os, from, to);
        this.moved(from, to);
      }
      if (dir !== this.rootDir) this.expanded.add(dir);
      this.flash(
        `${copy ? "Copied" : "Moved"} ${basename(from)} to ${basename(dir) || "/"}`,
      );
    } catch (error) {
      this.flash(
        `Couldn't ${copy ? "copy" : "move"} ${basename(from)} (${errorCode(error)})`,
        true,
      );
    }
    await this.renderTree();
  }

  /** Tabs reorder as you drag, so the drop itself has nothing left to do. */
  private bindTabDrag(): void {
    this.tabsEl.addEventListener("dragover", (e) => {
      if (this.dragTab === null || !e.dataTransfer?.types.includes(DRAG_TAB))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const over = (e.target as HTMLElement).closest<HTMLElement>(".code-tab");
      const tab = this.tabs.find((t) => t.path === this.dragTab);
      if (!over || !tab || over === tab.el) return;
      const box = over.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      over.insertAdjacentElement(after ? "afterend" : "beforebegin", tab.el);
      const order = [...this.tabsEl.children];
      this.tabs.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
    });
    // Without this the browser plays a "drag failed" animation back to the tab.
    this.tabsEl.addEventListener("drop", (e) => {
      if (this.dragTab !== null) e.preventDefault();
    });
  }

  private tabMenu(path: string): (MenuEntry | null)[] {
    const others = this.tabs.filter((t) => t.path !== path);
    return [
      { label: "Close", action: () => void this.closeTabAt(path) },
      {
        label: "Close Others",
        action: () => void this.closeMany(others),
        disabled: others.length === 0,
      },
      { label: "Close All", action: () => void this.closeMany([...this.tabs]) },
      null,
      {
        label: "Copy Path",
        action: () =>
          void this.os.clipboard
            .writeText(path)
            .catch(() => this.flash("Couldn't copy to clipboard", true)),
      },
      {
        label: "Reveal in Explorer",
        action: () => void this.revealInTree(path),
        disabled: this.rootDir === null || !isInside(path, this.rootDir),
      },
    ];
  }

  /** Closes in order; a Cancel at any save prompt leaves the rest open. */
  private async closeMany(tabs: Tab[]): Promise<void> {
    for (const tab of tabs) if (!(await this.closeTab(tab))) return;
  }

  /** Expands the explorer down to `path` and scrolls its row into view. */
  private async revealInTree(path: string): Promise<void> {
    const root = this.rootDir;
    if (root === null || !isInside(path, root))
      return this.flash("Not inside the open folder");
    for (
      let dir = dirname(path);
      dir !== root && isInside(dir, root);
      dir = dirname(dir)
    )
      this.expanded.add(dir);
    this.selectedDir = dirname(path);
    this.ensureView("explorer");
    await this.renderTree();
    this.tree
      .querySelector<HTMLElement>(`.code-row[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  // ---- explorer -----------------------------------------------------------

  private async renderTree(): Promise<void> {
    await this.loadLaunch();
    if (this.rootDir === null) return;
    const rows = document.createDocumentFragment();
    await this.renderDir(this.rootDir, 0, rows);
    // Kept across the re-render a save, refresh or spring-loaded drag triggers.
    const scroll = this.tree.scrollTop;
    this.tree.replaceChildren(rows);
    this.tree.scrollTop = scroll;
    this.highlight();
    this.tree.querySelector<HTMLInputElement>(".code-row-input")?.focus();
  }

  private async renderDir(
    dir: string,
    depth: number,
    into: DocumentFragment,
  ): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await this.os.fs.readdir(dir);
    } catch (error) {
      into.append(
        el("div", "code-tree-note", `Can't read folder (${errorCode(error)})`),
      );
      return;
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
    if (this.pending?.dir === dir) into.append(this.pendingRow(depth));
    if (depth === 0 && entries.length === 0 && !this.pending) {
      into.append(el("div", "code-tree-note", "This folder is empty."));
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      const isDir = entry.kind === "directory";
      const row = el("div", "code-row");
      row.setAttribute("role", "treeitem");
      row.dataset.path = path;
      row.dataset.dir = String(isDir);
      row.dataset.readonly = String(entry.readonly);
      row.classList.toggle(
        "cut",
        !!this.clipboard?.cut && this.clipboard.path === path,
      );
      row.style.paddingLeft = `${10 + depth * 12}px`;
      row.title = path;

      if (isDir) {
        row.setAttribute("aria-expanded", String(this.expanded.has(path)));
        row.append(
          el("span", `code-chevron${this.expanded.has(path) ? " open" : ""}`),
        );
      } else {
        row.append(el("span", "code-chevron-spacer"), badge(path));
      }
      if (this.renaming === path) {
        row.classList.add("editing");
        row.append(this.renameInput(path));
        into.append(row);
        if (isDir && this.expanded.has(path))
          await this.renderDir(path, depth + 1, into);
        continue;
      }
      row.append(el("span", "code-row-name", entry.name));
      this.makeDraggable(row, path, isDir, entry.readonly);

      if (!entry.readonly) {
        const del = el("button", "code-icon-btn code-row-del", "×");
        del.title = isDir ? "Delete Folder" : "Delete File";
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.remove(path);
        });
        row.append(del);
      }

      row.addEventListener("click", () => {
        if (!isDir) return void this.open(path);
        this.selectedDir = path;
        if (!this.expanded.delete(path)) this.expanded.add(path);
        void this.renderTree();
      });
      into.append(row);
      if (isDir && this.expanded.has(path))
        await this.renderDir(path, depth + 1, into);
    }
  }

  private highlight(): void {
    for (const row of this.tree.querySelectorAll<HTMLElement>(".code-row")) {
      const path = row.dataset.path;
      row.classList.toggle("active", path === this.active?.path);
      row.classList.toggle(
        "selected",
        row.dataset.dir === "true" && path === this.selectedDir,
      );
    }
  }

  private renameInput(path: string): HTMLInputElement {
    const input = el("input", "code-row-input");
    input.spellcheck = false;
    input.value = basename(path);
    let settled = false;
    const settle = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      if (commit && name) void this.rename(path, name);
      else {
        this.renaming = null;
        void this.renderTree();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") settle(true);
      else if (e.key === "Escape") settle(false);
    });
    input.addEventListener("blur", () => settle(true));
    // Select the stem, like VS Code, so typing keeps the extension.
    requestAnimationFrame(() => {
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
    return input;
  }

  private async startCreate(kind: Pending["kind"]): Promise<void> {
    if (this.rootDir === null) return;
    this.ensureView("explorer");
    if (this.selectedDir !== this.rootDir) this.expanded.add(this.selectedDir);
    this.pending = { dir: this.selectedDir, kind };
    await this.renderTree();
  }

  private pendingRow(depth: number): HTMLElement {
    const pending = this.pending as Pending;
    const row = el("div", "code-row editing");
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.append(
      pending.kind === "directory"
        ? el("span", "code-chevron")
        : el("span", "code-chevron-spacer"),
    );
    const input = el("input", "code-row-input");
    input.spellcheck = false;
    input.placeholder =
      pending.kind === "directory" ? "folder name" : "file name";
    let settled = false;
    const settle = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      this.pending = null;
      if (commit && name) void this.create(pending, name);
      else void this.renderTree();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") settle(true);
      else if (e.key === "Escape") settle(false);
    });
    input.addEventListener("blur", () => settle(true));
    row.append(input);
    return row;
  }

  private async create({ dir, kind }: Pending, name: string): Promise<void> {
    if (name.includes("/") || name === "." || name === "..") {
      this.flash(`"${name}" is not a valid name`, true);
      return this.renderTree();
    }
    const path = join(dir, name);
    try {
      if (kind === "directory") {
        await this.os.fs.mkdir(path);
        this.expanded.add(path);
        this.selectedDir = path;
      } else {
        await this.os.fs.writeTextFile(path, "");
      }
    } catch (error) {
      this.flash(`Couldn't create ${name} (${errorCode(error)})`, true);
    }
    await this.renderTree();
    if (kind === "file") await this.open(path);
  }

  private async remove(path: string): Promise<void> {
    const choice = await this.dialog(
      `Delete '${basename(path)}'?`,
      "This can't be undone.",
      ["Delete", "Cancel"],
    );
    if (choice !== "Delete") return;
    try {
      await removeTree(this.os, path);
    } catch (error) {
      this.flash(`Couldn't delete (${errorCode(error)})`, true);
    }
    // Even a failed removeTree may have deleted part of the folder.
    for (const tab of this.tabs.filter((t) => isInside(t.path, path)))
      this.dropTab(tab);
    if (isInside(this.selectedDir, path)) this.selectedDir = dirname(path);
    for (const p of this.expanded)
      if (isInside(p, path)) this.expanded.delete(p);
    if (this.clipboard && isInside(this.clipboard.path, path))
      this.clipboard = null;
    await this.renderTree();
  }

  // ---- quick open ---------------------------------------------------------

  /**
   * Ctrl/Cmd+P: type part of a path, open the file. The folder is walked once
   * per opening rather than kept in sync, which is cheap at these sizes.
   */
  private async openPalette(): Promise<void> {
    const root = this.rootDir;
    if (this.palette) return this.palette.close();
    if (root === null) return this.flash("Open a folder first");

    const backdrop = el("div", "code-modal-backdrop");
    const box = el("div", "code-modal code-palette");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const input = el("input", "code-palette-input");
    input.placeholder = "Go to file by name";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Go to file");
    const list = el("div", "code-palette-list");
    list.setAttribute("role", "listbox");
    list.replaceChildren(el("div", "code-tree-note", "Indexing\u2026"));
    box.append(input, list);
    backdrop.append(box);
    this.root.append(backdrop);
    const close = (): void => {
      backdrop.remove();
      this.palette = null;
      if (this.active) this.view.focus();
    };
    this.palette = { el: backdrop, close };
    input.focus();
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });

    const files = await this.indexFiles(root);
    // Closed, or reopened, while the walk was running.
    if (this.palette?.el !== backdrop) return;

    let rows: HTMLElement[] = [];
    let at = 0;
    const select = (i: number): void => {
      if (rows.length === 0) return;
      at = (i + rows.length) % rows.length;
      rows.forEach((row, j) => row.classList.toggle("active", j === at));
      rows[at].scrollIntoView({ block: "nearest" });
    };
    const render = (): void => {
      const query = input.value.toLowerCase().replace(/\s+/g, "");
      const hits =
        query === ""
          ? files.slice(0, PALETTE_LIMIT)
          : files
              .flatMap((path) => {
                const points = score(path.slice(root.length + 1), query);
                return points === null ? [] : [{ path, points }];
              })
              .sort((a, b) => b.points - a.points)
              .slice(0, PALETTE_LIMIT)
              .map((hit) => hit.path);
      rows = hits.map((path) => {
        const rel = path.slice(root.length + 1);
        const slash = rel.lastIndexOf("/");
        const row = el("div", "code-row");
        row.dataset.path = path;
        row.setAttribute("role", "option");
        row.style.paddingLeft = "10px";
        row.title = path;
        row.append(
          badge(path),
          el("span", "code-row-name", basename(path)),
          el("span", "code-config-detail", slash < 0 ? "" : rel.slice(0, slash)),
        );
        // mousedown, not click: the input would blur first and close us.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          close();
          void this.open(path);
        });
        return row;
      });
      list.replaceChildren(
        ...(rows.length > 0
          ? rows
          : [el("div", "code-tree-note", "No matching files.")]),
      );
      select(0);
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") select(at + 1);
      else if (e.key === "ArrowUp") select(at - 1);
      else if (e.key === "Enter") {
        const path = rows[at]?.dataset.path;
        close();
        if (path !== undefined) void this.open(path);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    render();
  }

  /** Every file under `root`, depth-first, skipping the heavy folders. */
  private async indexFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: DirEntry[];
      try {
        entries = await this.os.fs.readdir(dir);
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= INDEX_LIMIT) return;
        const path = join(dir, entry.name);
        if (entry.kind === "directory") {
          if (!SEARCH_SKIP.has(entry.name)) await walk(path);
        } else {
          out.push(path);
        }
      }
    };
    await walk(root);
    return out;
  }

  // ---- tabs & editing -----------------------------------------------------

  /** `mustExist: false` opens a missing file as an empty buffer; saving creates it. */
  private async open(path: string, mustExist = true): Promise<void> {
    // Phone width: the sidebar covers the editor (code.css), so get it out of the way.
    if (
      matchMedia("(max-width: 600px)").matches &&
      !this.root.classList.contains("no-sidebar")
    ) {
      this.toggleSidebar();
    }
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) return this.activate(existing);

    let text = "";
    let readonly = false;
    let binary = false;
    try {
      readonly = (await this.os.fs.stat(path)).readonly;
      const bytes = await this.os.fs.readFile(path);
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        binary = text.includes("\0");
      } catch {
        binary = true;
      }
      // Not text: show the raw bytes (one char per byte), read-only so saving can't corrupt it.
      if (binary) {
        text = new TextDecoder("latin1").decode(bytes);
        readonly = true;
      }
    } catch (error) {
      if (mustExist || errorCode(error) !== "ENOENT") {
        this.flash(
          `Couldn't open ${basename(path)} (${errorCode(error)})`,
          true,
        );
        return;
      }
    }

    const lang = LANGS[extOf(path)];
    const state = EditorState.create({
      doc: text,
      extensions: [
        this.shared,
        lang ? lang[1]() : [],
        EditorState.readOnly.of(readonly),
      ],
    });
    const tab: Tab = {
      path,
      state,
      saved: state.doc,
      readonly,
      el: this.tabEl(path),
    };
    this.tabs.push(tab);
    this.tabsEl.append(tab.el);
    this.activate(tab);
    if (binary)
      this.flash(
        `${basename(path)}: file type not supported, showing raw bytes`,
        true,
      );
  }

  private tabEl(path: string): HTMLElement {
    const node = el("div", "code-tab");
    node.setAttribute("role", "tab");
    node.title = path;
    const close = el("button", "code-tab-close");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.closeTabAt(path);
    });
    node.append(
      badge(path),
      el("span", "code-tab-name", basename(path)),
      close,
    );
    node.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void this.closeTabAt(path);
      }
    });
    node.addEventListener("click", () => {
      const tab = this.tabs.find((t) => t.path === path);
      if (tab) this.activate(tab);
    });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY, this.tabMenu(path));
    });
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      this.dragTab = path;
      e.dataTransfer?.setData(DRAG_TAB, path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      node.classList.add("dragging");
    });
    return node;
  }

  private closeTabAt(path: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.path === path);
    return tab ? this.closeTab(tab) : Promise.resolve(true);
  }

  private activate(tab: Tab): void {
    this.active = tab;
    this.view.setState(tab.state);
    for (const t of this.tabs) {
      t.el.classList.toggle("active", t === tab);
      t.el.setAttribute("aria-selected", String(t === tab));
    }
    tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.root.classList.remove("empty");
    this.renderCrumbs();
    this.highlight();
    this.updateStatus();
    this.updateTitle();
    this.updateRun();
    this.view.focus();
  }

  private isDirty(tab: Tab): boolean {
    return !tab.state.doc.eq(tab.saved);
  }

  private onUpdate(u: ViewUpdate): void {
    const tab = this.active;
    if (!tab || u.view !== this.view) return;
    tab.state = u.state;
    if (u.docChanged) {
      tab.el.classList.toggle("dirty", this.isDirty(tab));
      this.updateTitle();
      this.updateRun();
    }
    if (u.docChanged || u.selectionSet) this.updateCursor();
  }

  private async save(tab: Tab): Promise<boolean> {
    if (tab.readonly) {
      this.flash(`${basename(tab.path)} is read-only`, true);
      return false;
    }
    const doc = tab.state.doc;
    try {
      await this.os.fs.writeTextFile(tab.path, doc.toString());
    } catch (error) {
      this.flash(
        `Couldn't save ${basename(tab.path)} (${errorCode(error)})`,
        true,
      );
      return false;
    }
    tab.saved = doc;
    tab.el.classList.toggle("dirty", this.isDirty(tab));
    this.updateTitle();
    this.flash(`Saved ${basename(tab.path)}`);
    // A save may have created the file.
    void this.renderTree();
    return true;
  }

  private async closeTab(tab: Tab): Promise<boolean> {
    if (this.isDirty(tab)) {
      this.activate(tab);
      const choice = await this.dialog(
        `Do you want to save the changes you made to ${basename(tab.path)}?`,
        "Your changes will be lost if you don't save them.",
        ["Save", "Don't Save", "Cancel"],
      );
      if (choice === null || choice === "Cancel") return false;
      if (choice === "Save" && !(await this.save(tab))) return false;
    }
    this.dropTab(tab);
    return true;
  }

  private dropTab(tab: Tab): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    tab.el.remove();
    if (this.active !== tab) return;
    const next = this.tabs[index] ?? this.tabs[index - 1];
    if (next) this.activate(next);
    else this.showWelcome();
  }

  private showWelcome(): void {
    this.active = null;
    this.root.classList.add("empty");
    this.crumbs.replaceChildren();
    this.highlight();
    this.updateStatus();
    this.updateTitle();
    this.updateRun();
  }

  private async quit(): Promise<void> {
    const dirty = this.tabs.filter((t) => this.isDirty(t));
    if (dirty.length > 0) {
      const choice = await this.dialog(
        dirty.length === 1
          ? `Do you want to save the changes you made to ${basename(dirty[0].path)}?`
          : `Do you want to save the changes to ${dirty.length} files?`,
        "Your changes will be lost if you don't save them.",
        ["Save All", "Don't Save", "Cancel"],
      );
      if (choice === null || choice === "Cancel") return;
      if (choice === "Save All") {
        for (const tab of dirty) if (!(await this.save(tab))) return;
      }
    }
    await this.os.process.exit(0);
  }

  // ---- status -------------------------------------------------------------

  private renderCrumbs(): void {
    if (!this.active) return;
    const parts = this.active.path.split("/").filter(Boolean);
    this.crumbs.replaceChildren();
    parts.forEach((part, i) => {
      if (i > 0) this.crumbs.append(el("span", "code-crumb-sep", "›"));
      const last = i === parts.length - 1;
      if (last) this.crumbs.append(badge(this.active!.path));
      this.crumbs.append(
        el("span", last ? "code-crumb current" : "code-crumb", part),
      );
    });
  }

  private updateTitle(): void {
    const dirty = this.active ? this.isDirty(this.active) : false;
    const title = this.active
      ? `${basename(this.active.path)}${dirty ? " ●" : ""} — Code`
      : "Code";
    if (title === this.title) return;
    this.title = title;
    void this.win.setTitle(title);
  }

  private updateCursor(): void {
    if (!this.active) return;
    const { state } = this.view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const selected = state.selection.ranges.reduce(
      (n, r) => n + r.to - r.from,
      0,
    );
    this.status.cursor.textContent =
      `Ln ${line.number}, Col ${head - line.from + 1}` +
      (selected ? ` (${selected} selected)` : "");
  }

  private updateStatus(): void {
    const tab = this.active;
    this.status.msg.classList.remove("error");
    this.status.msg.textContent = tab?.readonly ? "Read-only" : "";
    this.status.indent.textContent = tab ? "Spaces: 2" : "";
    this.status.enc.textContent = tab ? "UTF-8" : "";
    this.status.lang.textContent = tab
      ? (LANGS[extOf(tab.path)]?.[0] ?? "Plain Text")
      : "";
    if (tab) this.updateCursor();
    else this.status.cursor.textContent = "";
  }
}

export async function main(
  os: AppInterface,
  args: string[] = [],
): Promise<void> {
  await followAccent(os);
  const win = await os.windows.create({ title: "Code" });
  const editor = new Editor(os, win);
  await editor.start(args);
}
