# 7. Building a built-in app

A *built-in* app ships with the OS: TypeScript in `src/apps/<id>/`, bundled by
Vite, run as a sandboxed iframe process. (To write apps *inside* the running
OS instead, see [User apps](09-user-apps.md).)

## What you get for free

Drop two files in a folder and the system does the rest:

| Automatic | Where it comes from |
| --------- | ------------------- |
| `/ProgramFiles/<id>` exists and is executable | `binfmt.ts` globs `src/apps/*/app.ts` |
| The realm loads your `main.ts` | `runtime/iframe-entry.ts` globs `src/apps/*/main.ts` |
| It appears in the app menu / launcher / Spotlight | `apps/registry.ts` reads `launcher` from your manifest |
| `?launch=<id>` opens it | the launcher program uses the registry |
| It is startable from the terminal as `<id>` | `PATH=/ProgramFiles` |
| Admin-only if you say so | `admin: true` → mode `0750`, gid 10 |

## Step by step: a Notes app

### 1. The manifest: `src/apps/notes/app.ts`

```ts
import type { AppManifest } from "../../kernel/binfmt";

export default {
  window: {
    title: "Notes",
    width: 480,
    height: 560,
    minWidth: 320,
    minHeight: 360,
    // translucent: true,       // frosted glass; make html/body background transparent
  },
  launcher: { name: "Notes", icon: "/assets/icons/notes.svg" },
  // admin: true,               // only the admin group may run (and see) it
} satisfies AppManifest;
```

`AppManifest` fields ([`binfmt.ts`](../src/kernel/binfmt.ts)):

| Field | Meaning |
| ----- | ------- |
| `window` | initial `WindowOptions` ([windows](05-windows.md)) |
| `launcher` | `{ name, icon }`. **Omit it to hide the app** from the menu (it can still be exec'd) |
| `admin` | owner/admin group only; hidden from everyone else, and the kernel refuses to exec it |
| `url` | wrap an external site instead of running code (then there's no `main.ts`; see Fintrack) |
| `commands`, `search` | Spotlight integration ([patterns](10-patterns.md#spotlight-commands)) |

The id is the **folder name**: `notes` → `/ProgramFiles/notes`, launcher id
`notes`.

### 2. The icon: `public/assets/icons/notes.svg`

Served from the site root (`/assets/icons/notes.svg`). Look at an existing one
for size and style.

### 3. The program: `src/apps/notes/main.ts`

```ts
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import notesHTML from "./notes.html?raw";
import "../../ui/theme.css";
import "../../ui/kit.css";
import "./notes.css";

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);                        // accent colour + re-read on SIGHUP

  const handle = await os.windows.create({ title: "Notes" });   // claim the window
  void handle.onCloseRequest(() => void os.process.exit(0));    // closing the window ends the process

  document.body.innerHTML = notesHTML;           // your own markup only
  const area = document.querySelector<HTMLTextAreaElement>("textarea")!;

  const file = `${(await os.process.env()).HOME ?? "/"}/.config/notes.txt`;
  area.value = await os.fs.readTextFile(file).catch(() => "");

  let timer: ReturnType<typeof setTimeout> | undefined;
  area.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void os.fs.writeTextFile(file, area.value), 400);
  });
}
```

`notes.html`:

```html
<textarea placeholder="Write something…" spellcheck="false"></textarea>
```

Rules of the shape:

- Export `main(os, args)`. `args` are what the caller spawned you with
  (e.g. Files opens a document with `spawn("/ProgramFiles/code", [path])`).
- **Importing CSS in `main.ts` is how styles load** (Vite injects it into your
  frame). `ui/theme.css` gives the design tokens; `ui/kit.css` the native
  look for plain HTML. Many apps import only `theme.css` and style
  themselves; both are fine.
- Import HTML templates with `?raw` and assign to `document.body.innerHTML`,
  or build nodes by hand. `<script>` in templates never runs.
- You own the **whole document** (`document.body`) of your frame. There is no
  `handle.body`: that exists only for in-page programs.
- `main()` returning doesn't exit. GUI apps stay alive until the window closes
  or they call `os.process.exit`.

### 4. Run it

```sh
pnpm dev            # Vite on :5173, proxies /api to the Node API on :8787 (pnpm dev:api)
```

Open it from the app menu, `http://localhost:5173/?launch=notes`, or type
`notes` in the Terminal. Without a terminal, `console.log` output is at
`cat /proc/<pid>/log` (pid from `ps`).

### 5. Typecheck

```sh
pnpm build          # tsc (strict) && tsc -p server && vite build
```

`tsc` also enforces that the wire stays aligned. `noUnusedLocals`,
`noUnusedParameters` and `erasableSyntaxOnly` are on (no `enum`s or
parameter properties).

## What your app can and can't do

You get `AppInterface` ([syscalls](03-syscalls.md)). Practical consequences:

| Want to... | Do this |
| ---------- | ------- |
| persist data | `os.fs` under `~/.config/...` (or the cloud mount with a fallback: see patterns) |
| open a link | `os.shell.openExternal(url)` from a **click handler** (https/mailto only) |
| copy/paste | `os.clipboard` (not `navigator.clipboard`) |
| pick a file | `os.dialog.open({ kind: "file" })` |
| open another app/file | `os.process.spawn("/ProgramFiles/<id>", [args])` |
| react to files changing | `os.events.subscribe(["fs.changed"], ...)` |
| show something in the top bar | `os.display.addStatusItem` |
| talk to the network | you can't directly; see [security](06-security.md) |
| load an external image/font/script | blocked by CSP; bundle it or embed as `data:` |
| use `localStorage` / IndexedDB / cookies | not available (opaque origin); use `os.fs` |
| use npm packages | allowed *in built-in apps* (they're bundled by Vite, e.g. `marked`, CodeMirror, `pdfjs-dist`), subject to the CSP at runtime |
| open a popup / `window.open` | blocked; use `openExternal` |

## Headless commands (optional)

If your manifest declares `commands`, add `src/apps/<id>/commands.ts`. It runs
as a **worker** (`/ProgramFiles/<id>.commands`), so it must not touch the DOM
or import CSS:

```ts
import { commandMain, type CommandHandler, type SearchHandler } from "../../utils/commands";

export const command: CommandHandler = async (os, id, input) => {
  if (id !== "new") return { error: `Notes has no command "${id}".` };
  await os.fs.writeTextFile(`${(await os.process.env()).HOME}/note.txt`, input);
  return { message: `Saved “${input}”` };
};
export const search: SearchHandler = async (os, query) => [
  { title: `Jot down: ${query}`, command: "new", input: query },
];
export const main = commandMain(command, search);
```

Details in [patterns → Spotlight commands](10-patterns.md#spotlight-commands).

## App checklist

- [ ] `app.ts` with sensible `minWidth`/`minHeight` (the app must work at the minimum)
- [ ] Works at phone width (windows are fullscreen there) and in a narrow window
- [ ] `followAccent(os)` called, and colours come from `--app-*` tokens
- [ ] If it should live-update when Settings changes: its id is in `RELOAD_ON_HUP` in `src/apps/settings/main.ts` (Settings only SIGHUPs the listed programs, because SIGHUP's default action is to kill; see [patterns](10-patterns.md#theming-and-accent))
- [ ] `onCloseRequest` → `os.process.exit(0)` (or a save prompt)
- [ ] State persisted, errors handled and surfaced (never a silent failure)
- [ ] No `innerHTML` with data that isn't yours
- [ ] Reads follow `fs.changed` if another process can write the same file
- [ ] `pnpm build` is clean; add a `*.check.ts` for pure logic (see [testing](12-build-and-deploy.md#checks))
- [ ] New product behaviour recorded in `PRODUCT.md`

## Reading real examples

| App | Worth reading for |
| --- | ----------------- |
| `snake` | the smallest complete GUI app; status item; per-app config file |
| `about` | read-only system info, `windows.create` + HTML template |
| `todo` | cloud-with-fallback store, `fs.changed`, headless commands + search |
| `calendar` | big app split into pure modules each with a `*.check.ts` |
| `terminal` | ptys, `spawn` with `fds`, line discipline from the master side |
| `files` | `readdir`, drag/drop, `dialog`, Bin, tar, `open with` |
| `settings` | writing config then `kill(SIGHUP)` to apply it everywhere |
| `fintrack` | the `url` form: wrapping an external site, `admin: true` |
