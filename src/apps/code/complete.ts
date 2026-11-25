// Autocomplete for programs written inside the OS (jsapp / node / sh-less JS).
//
// CodeMirror's JS support already completes browser globals (`document.…`), so this
// adds what it can't know about: the `os` API, `os:ui`, import paths, and the
// boilerplate. It is a hand-written table, not a type checker, so `area.` after
// `document.querySelector(…)` is still untyped.
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript";
import type { Extension } from "@codemirror/state";
import type { AppInterface } from "../../kernel/syscalls/api";

/**
 * One line per `os.*` member: the signature shown next to the completion.
 * Typed against AppInterface, so adding or removing a syscall there is a compile
 * error here until the table is updated.
 */
const API: { [N in keyof AppInterface]: { [M in keyof AppInterface[N]]: string } } = {
  display: {
    workArea: "(): Promise<Rect>",
    addStatusItem: "(spec, onSelect): Promise<number>",
    updateStatusItem: "(id, patch): Promise<void>",
    removeStatusItem: "(id): Promise<void>",
    claimHotkey: "(name, onPress): Promise<void>",
  },
  windows: {
    create: "(options: { title, width, height, … }): Promise<WindowHandle>",
    list: "(): Promise<WindowInfo[]>",
    focus: "(windowId): Promise<void>",
    setMinimized: "(windowId, minimized): Promise<void>",
    tile: "(windowId, target): Promise<void>",
    setTitle: "(windowId, title): Promise<void>",
    close: "(windowId): Promise<void>",
    onCloseRequest: "(windowId, callback): Promise<void>",
    setSize: "(windowId, { width?, height? }): Promise<void>",
    setFrame: "(windowId, frame): Promise<void>",
    setVisible: "(windowId, visible): Promise<void>",
  },
  process: {
    signal: "AbortSignal",
    pid: "number",
    onSignal: "(signal, handler): Promise<() => void>",
    wait: "(pid, options?): Promise<WaitStatus>",
    spawn: "(path, args?, options?): Promise<number>",
    exit: "(code?): Promise<void>",
    list: "(): Promise<ProcessInfo[]>",
    kill: "(pid, signal): Promise<void>",
    history: "(): Promise<ExitRecord[]>",
    chdir: "(path): Promise<void>",
    cwd: "(): Promise<string>",
    env: "(): Promise<Record<string, string>>",
    setenv: "(name, value?): Promise<void>",
    ids: "(): Promise<Ids>",
    setsid: "(): Promise<number>",
  },
  timers: {
    setInterval: "(callback, ms): Promise<number>",
    clearInterval: "(id): Promise<void>",
  },
  events: {
    subscribe: "(types, handler): Promise<() => void>",
  },
  system: {
    reboot: "(kind): Promise<void>",
    sync: "(): Promise<void>",
  },
  shell: {
    openExternal: "(url): Promise<void>",
    location: "(): Promise<LocationInfo>",
    download: "(path): Promise<void>",
  },
  api: {
    fetch: "(path, request?): Promise<ApiResponse>",
  },
  net: {
    fetch: "(url, request?): Promise<NetResponse>",
  },
  dialog: {
    open: "(options): Promise<string | null>",
  },
  clipboard: {
    writeText: "(text): Promise<void>",
    readText: "(): Promise<string>",
  },
  fs: {
    readFile: "(path): Promise<Uint8Array>",
    writeFile: "(path, data): Promise<void>",
    readTextFile: "(path): Promise<string>",
    writeTextFile: "(path, text): Promise<void>",
    readdir: "(path): Promise<DirEntry[]>",
    stat: "(path): Promise<StatResult>",
    mkdir: "(path): Promise<void>",
    unlink: "(path): Promise<void>",
    rename: "(from, to): Promise<void>",
    rmdir: "(path): Promise<void>",
    chmod: "(path, mode): Promise<void>",
    chown: "(path, uid, gid): Promise<void>",
  },
  io: {
    open: "(path, flags): Promise<number>",
    close: "(fd): Promise<void>",
    read: "(fd, length): Promise<Uint8Array>",
    write: "(fd, data): Promise<number>",
    seek: "(fd, offset, whence?): Promise<number>",
    dup: "(fd, to?): Promise<number>",
    fstat: "(fd): Promise<Stat>",
    listFds: "(): Promise<FdInfo[]>",
    pipe: "(): Promise<{ read, write }>",
    openpty: "(): Promise<{ master, slave }>",
    tcgetattr: "(fd): Promise<Termios>",
    tcsetattr: "(fd, changes): Promise<void>",
    tcgetpgrp: "(fd): Promise<number | null>",
    tcsetpgrp: "(fd, pgid): Promise<void>",
    getWinsize: "(fd): Promise<{ rows, cols }>",
    setWinsize: "(fd, size): Promise<void>",
  },
};

/** What `win` (the result of `os.windows.create`) offers. */
const WINDOW: Record<string, string> = {
  id: "number",
  body: "HTMLElement",
  setTitle: "(title): Promise<void>",
  close: "(): Promise<void>",
  onCloseRequest: "(callback): Promise<void>",
};

/** Exports of `os:ui` (src/ui/kit.ts). */
const UI: Record<string, string> = {
  h: "(tag, props?, ...children): HTMLElement",
  html: "(markup): DocumentFragment",
  mount: "(...nodes): void",
};

const memberOption = (name: string, detail: string, callable: boolean): Completion => ({
  label: name,
  detail: callable ? ` ${detail}` : `: ${detail}`,
  type: callable ? "method" : "property",
});

const namespaceOptions = (): Completion[] =>
  Object.entries(API).map(([name, members]) => ({
    label: name,
    type: "namespace",
    detail: ` ${Object.keys(members).length} calls`,
  }));

const membersOf = (table: Record<string, string>): Completion[] =>
  Object.entries(table).map(([name, detail]) => memberOption(name, detail, detail.startsWith("(")));

/** `const win = await os.windows.create(…)`: names bound to a window handle. */
function windowNames(doc: string): Set<string> {
  const names = new Set<string>();
  for (const m of doc.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?os\.windows\.create\b/g)) {
    names.add(m[1]);
  }
  return names;
}

/** `os.fs.` / `os.` / `win.`: the members of a known object. */
function memberSource(context: CompletionContext): CompletionResult | null {
  const chain = context.matchBefore(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.\w*$/);
  if (!chain) return null;
  const parts = chain.text.split(/\??\./);
  const prefix = parts.pop() ?? "";
  const from = chain.to - prefix.length;

  let options: Completion[] | null = null;
  if (parts[0] === "os") {
    const path = parts.slice(1);
    if (path.length === 0) options = namespaceOptions();
    else if (path.length === 1 && path[0] in API) {
      options = membersOf(API[path[0] as keyof AppInterface] as Record<string, string>);
    }
  } else if (parts.length === 1 && windowNames(context.state.doc.toString()).has(parts[0])) {
    options = membersOf(WINDOW);
  }
  return options ? { from, options, validFor: /^\w*$/ } : null;
}

const isJsApp = (doc: string): boolean => /^#!.*jsapp/.test(doc);

/** Where a new import line goes: after the shebang and `//@app` header lines. */
function importInsertPos(doc: string): number {
  let pos = 0;
  for (const line of doc.split("\n")) {
    if (!/^(#!|\/\/@app)/.test(line)) break;
    pos += line.length + 1;
  }
  return Math.min(pos, doc.length);
}

const UI_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])os:ui\2;?/;

/** Accepting `mount` also adds it to the `os:ui` import (or creates the import). */
function autoImport(name: string): Completion["apply"] {
  return (view: EditorView, _completion, from, to) => {
    const doc = view.state.doc.toString();
    const insert = { from, to, insert: name };
    const existing = UI_IMPORT.exec(doc);
    if (existing) {
      const braces = existing.index + existing[0].indexOf("{");
      const names = existing[1].split(",").map((n) => n.trim()).filter(Boolean);
      const closing = braces + 1 + existing[1].length;
      view.dispatch({
        changes: [
          insert,
          { from: braces + 1, to: closing, insert: ` ${[...names, name].join(", ")} ` },
        ],
        selection: { anchor: from + name.length },
      });
      return;
    }
    const at = importInsertPos(doc);
    const line = `import { ${name} } from "os:ui";\n`;
    view.dispatch({
      changes: [{ from: at, insert: at > 0 && !doc.slice(0, at).endsWith("\n") ? `\n${line}` : line }, insert],
      selection: { anchor: from + name.length + line.length },
    });
  };
}

/** `h`, `html`, `mount` anywhere in a jsapp: complete the name and fix the import. */
function uiSource(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc.toString();
  if (!isJsApp(doc)) return null;
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (word.from > 0 && /[.\w$]/.test(doc[word.from - 1])) return null;
  const imported = new Set(
    (UI_IMPORT.exec(doc)?.[1] ?? "").split(",").map((n) => n.trim()),
  );
  const options: Completion[] = Object.entries(UI)
    .filter(([name]) => !imported.has(name))
    .map(([name, detail]) => ({
      label: name,
      detail: ` ${detail}`,
      info: "from os:ui (adds the import)",
      type: "function",
      boost: -2,
      apply: autoImport(name),
    }));
  return options.length ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
}

/** `import { | } from "os:ui"`: the names it exports. */
function uiNamesSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /import\s*\{(?:[^}]*,)?\s*(\w*)$/.exec(before);
  const after = line.text.slice(context.pos - line.from);
  if (!m || (/from/.test(after) && !/from\s*["']os:ui["']/.test(after))) return null;
  return { from: context.pos - m[1].length, options: membersOf(UI), validFor: /^\w*$/ };
}

export interface ImportContext {
  /** Path of the file being edited, to resolve `./` against. */
  currentPath(): string | null;
  readdir: AppInterface["fs"]["readdir"];
}

/** Resolve `rel` against `dir` ("a/b", "../c" -> "a/c"). */
function resolvePath(dir: string, rel: string): string {
  const out = rel.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of rel.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

const IMPORTABLE = /\.(?:js|mjs|ts|json|html|css|txt|md)$/;

/** `from "./ma|"`: `os:ui` and the files next to this one. */
function importSource(files: ImportContext): CompletionSource {
  return async (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const m = /(?:\bfrom\s*|\bimport\s*)(["'])([^"']*)$/.exec(before);
    if (!m) return null;
    const typed = m[2];
    const slash = typed.lastIndexOf("/");
    const from = context.pos - (typed.length - (slash + 1));

    const options: Completion[] = [];
    if (!typed.includes("/") && isJsApp(context.state.doc.toString())) {
      options.push({ label: "os:ui", type: "module", detail: " h, html, mount" });
    }
    const relative = typed.startsWith(".") || typed.startsWith("/");
    if (!typed.includes("/") && !relative) {
      options.push({ label: "./", type: "folder" }, { label: "../", type: "folder" });
    } else if (relative) {
      if (typed === "." || typed === "..") {
        options.push({ label: `${typed}/`, type: "folder" });
      } else {
        const current = files.currentPath();
        if (current) {
          const dir = resolvePath(current.slice(0, current.lastIndexOf("/")) || "/", typed.slice(0, slash + 1));
          const entries = await files.readdir(dir).catch(() => []);
          for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (entry.kind === "directory") {
              options.push({
                label: `${entry.name}/`,
                type: "folder",
                apply: (view, _c, f, t) => {
                  view.dispatch({
                    changes: { from: f, to: t, insert: `${entry.name}/` },
                    selection: { anchor: f + entry.name.length + 1 },
                  });
                  startCompletion(view);
                },
              });
            } else if (entry.kind === "file" && IMPORTABLE.test(entry.name)) {
              options.push({ label: entry.name, type: "file" });
            }
          }
        }
      }
    }
    return options.length ? { from, options, validFor: /^[^"'/]*$/ } : null;
  };
}

const SKELETONS: Completion[] = [
  snippetCompletion(
    `#!/ProgramFiles/jsapp
import { h, mount } from "os:ui";

export async function main(os, args) {
  const win = await os.windows.create({ title: "\${App}" });
  win.onCloseRequest(() => os.process.exit(0));

  mount(
    h("p", null, "\${Hello}"),
  );
}
`,
    { label: "jsapp", detail: " GUI app skeleton", type: "keyword", boost: 5 },
  ),
  snippetCompletion(
    `#!/ProgramFiles/node

export async function main(os, args) {
  \${}
}
`,
    { label: "nodeapp", detail: " CLI program skeleton", type: "keyword", boost: 5 },
  ),
];

/** `jsapp` / `nodeapp` in an empty file: the whole boilerplate. */
function skeletonSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w*/);
  if (!word || word.from !== 0 || context.state.doc.length !== word.to) return null;
  return { from: 0, options: SKELETONS, validFor: /^\w*$/ };
}

/** Language data that adds the OS completions to the JS and TS languages. */
export function osCompletions(files: ImportContext): Extension {
  const sources: CompletionSource[] = [
    memberSource,
    uiNamesSource,
    importSource(files),
    uiSource,
    skeletonSource,
  ];
  return [javascriptLanguage, typescriptLanguage, jsxLanguage, tsxLanguage].map((language) =>
    language.data.of({ autocomplete: (context: CompletionContext) => merge(sources, context) }),
  );
}

/** First source that has something to say wins; the language's own sources still run beside this one. */
async function merge(sources: CompletionSource[], context: CompletionContext): Promise<CompletionResult | null> {
  for (const source of sources) {
    const result = await source(context);
    if (result) return result;
  }
  return null;
}
