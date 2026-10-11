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
import { EditorView, type ViewUpdate } from "@codemirror/view";
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
import { followAccent } from "../../utils/settings";
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

const PLAY_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.5.5 0 0 0 .77.42l8-5.2a.5.5 0 0 0 0-.84l-8-5.2a.5.5 0 0 0-.77.42z" /></svg>';

/** Single-quotes a shell word when needed; sh has no escapes inside '...'. */
const quote = (word: string): string =>
  /^[\w./=:+-]+$/.test(word) ? word : `'${word}'`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** New file/folder name being typed inline in the tree. */
interface Pending {
  dir: string;
  kind: "file" | "directory";
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string): string =>
  p.slice(0, Math.max(p.lastIndexOf("/"), 1));
const join = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;
const extOf = (p: string): string => {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

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
  const [glyph, color] = BADGES[extOf(path)] ?? ["≡", "var(--app-text-faint)"];
  const node = el("span", "code-badge", glyph);
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

  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private title = "";
  private flashTimer = 0;
  private terminal: Terminal | null = null;
  private launch: LaunchConfig[] = [];
  private sidebarView: "explorer" | "run" = "explorer";

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

    void win.onCloseRequest(() => void this.quit());
    this.bindChrome();
    this.showWelcome();
  }

  public async start(args: string[]): Promise<void> {
    const [arg] = args;
    if (arg === undefined) return this.renderTree();
    const path = resolve(await this.os.process.cwd(), arg);
    let isDir = false;
    try {
      isDir = (await this.os.fs.stat(path)).kind === "directory";
    } catch {
      // Missing: open() shows an empty buffer and saving creates it.
    }
    if (isDir) return this.openFolder(path);
    await this.open(path, false);
    await this.renderTree();
  }

  private async openFolder(dir: string): Promise<void> {
    this.rootDir = dir;
    this.selectedDir = dir;
    this.expanded.clear();
    this.pending = null;
    this.field("root-name").textContent = basename(dir) || "/";
    this.root.classList.remove("no-folder");
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

    // Capture phase: beats CodeMirror and the browser's own Save dialog.
    window.addEventListener(
      "keydown",
      (e) => {
        const mod = IS_MAC ? e.metaKey : e.ctrlKey;
        let handled = true;
        if (mod && e.code === "KeyS")
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

  private toggleSidebar(): void {
    const hidden = this.root.classList.toggle("no-sidebar");
    this.field(`${this.sidebarView}-btn`).classList.toggle("active", !hidden);
  }

  /** Like VS Code: clicking the open view's icon hides the sidebar. */
  private showView(view: "explorer" | "run"): void {
    const hidden = this.root.classList.contains("no-sidebar");
    if (!hidden && view === this.sidebarView) return this.toggleSidebar();
    this.field(`${this.sidebarView}-btn`).classList.remove("active");
    this.sidebarView = view;
    this.field("explorer-view").hidden = view !== "explorer";
    this.field("run-view").hidden = view !== "run";
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
        el("div", "code-tree-note", "Open a folder to add launch configurations."),
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
    if (
      this.root.classList.contains("no-sidebar") ||
      this.sidebarView !== "run"
    )
      this.showView("run");
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

  // ---- explorer -----------------------------------------------------------

  private async renderTree(): Promise<void> {
    await this.loadLaunch();
    if (this.rootDir === null) return;
    const rows = document.createDocumentFragment();
    await this.renderDir(this.rootDir, 0, rows);
    this.tree.replaceChildren(rows);
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
      row.append(el("span", "code-row-name", entry.name));

      if (!entry.readonly) {
        const del = el("button", "code-icon-btn code-row-del", "×");
        del.title = isDir ? "Delete Folder" : "Delete File";
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.remove(path, isDir);
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

  private async startCreate(kind: Pending["kind"]): Promise<void> {
    if (this.rootDir === null) return;
    if (
      this.root.classList.contains("no-sidebar") ||
      this.sidebarView !== "explorer"
    )
      this.showView("explorer");
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

  private async remove(path: string, isDir: boolean): Promise<void> {
    const choice = await this.dialog(
      `Delete '${basename(path)}'?`,
      isDir ? "Only empty folders can be deleted." : "This can't be undone.",
      ["Delete", "Cancel"],
    );
    if (choice !== "Delete") return;
    try {
      await (isDir ? this.os.fs.rmdir(path) : this.os.fs.unlink(path));
    } catch (error) {
      const code = errorCode(error);
      this.flash(
        code === "ENOTEMPTY"
          ? "Folder is not empty"
          : `Couldn't delete (${code})`,
        true,
      );
      return;
    }
    for (const tab of this.tabs.filter((t) => t.path === path))
      this.dropTab(tab);
    if (this.selectedDir === path) this.selectedDir = dirname(path);
    this.expanded.delete(path);
    await this.renderTree();
  }

  // ---- tabs & editing -----------------------------------------------------

  /** `mustExist: false` opens a missing file as an empty buffer; saving creates it. */
  private async open(path: string, mustExist = true): Promise<void> {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) return this.activate(existing);

    let text = "";
    let readonly = false;
    try {
      readonly = (await this.os.fs.stat(path)).readonly;
      text = await this.os.fs.readTextFile(path);
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
