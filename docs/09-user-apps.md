# 9. User apps: building applications *inside* the OS

You can write, run and install programs entirely within PortfolioOS: edit in
the **Code** app, run from the Terminal or by clicking Run, ship as one file.
This is the OS's "app store without a store". The same `os` API as the
built-in apps, a more restricted sandbox, no build step.

The desktop ships a starter project (`src/System/Desktop/starter/`, with its
own `README.md`) that mirrors this page from the user's side.

## Three program types, chosen by the first line

| First line | Runs as | Realm |
| ---------- | ------- | ----- |
| `#!/ProgramFiles/jsapp` | a GUI app in its own window | sandboxed iframe, **user** host |
| `#!/ProgramFiles/node` | a command-line program (stdin/stdout/pipes) | worker, **user** host |
| `#!/ProgramFiles/sh` | a shell script | worker (system host) |

`./main.js` in a terminal, the Run button in Code, or double-clicking a
`.app.js` in Files all do the same thing: `spawn(path)`, which sees the
shebang and starts the interpreter with your file as `args[0]`
([processes → scripts](02-processes.md#scripts-)).

## A GUI app

```js
#!/ProgramFiles/jsapp
import { h, mount } from "os:ui";
import "./style.css";

export async function main(os, args) {
  const win = await os.windows.create({ title: "Counter" });
  win.onCloseRequest(() => os.process.exit(0));

  let n = 0;
  const label = h("p", null, "0");
  mount(
    h("h2", null, "Counter"),
    label,
    h("button", { class: "primary", onclick: () => { label.textContent = String(++n); } }, "Add"),
  );
}
```

Differences from a built-in app:

- The module is **plain JavaScript** (no TypeScript, no Vite). `main` is
  `export async function main(os, args)`, same contract.
- `os:ui` is a built-in import that provides `h`, `html` and `mount`
  (re-exports of [`ui/kit.ts`](../src/ui/kit.ts)):
  - `h(tag, props, ...children)`: build elements. `on*` props become
    listeners; `class`, `style` objects work; other props are set as
    properties when the element has one, else as attributes. **Text children
    are text, never HTML.**
  - `mount(...nodes)`: replace the window's content (`document.body`).
  - `html(markup)`: parse *your own* markup into a fragment. Never pass it
    file contents or user input.
- **The look is automatic**: `theme.css` and `kit.css` are loaded for you, so
  plain `button` (`.primary` / `.danger`), `input`, `select`, `textarea`,
  `.toolbar`, `.list > li`, `.row`, `.stack`, `.card`, `.field`, `.muted`,
  `.spacer`, tables and `<input type="checkbox" role="switch">` match the OS.
  Colours come from CSS variables such as `--app-bg`, `--app-surface`,
  `--app-text`, `--app-text-dim`, `--app-accent`, `--app-danger`.
- The accent follows Settings (`jsapp` calls `followAccent` for you).
- `console.log/info/debug` go to fd 1 and `console.warn/error` to fd 2, so they
  land in the terminal you started it from, or `/proc/<pid>/log` if you didn't
  start it from one. Uncaught errors show a **"crashed"** page in the window
  with the message instead of vanishing.
- Default window title and size come from the manifest (`//@app` or
  `app.json`), then your `windows.create` options override.
- You can't call `windows.create` more than once (one window per process).

## A CLI program

```js
#!/ProgramFiles/node
export async function main(os, args) {
  const text = new TextDecoder().decode(await os.io.read(0, 65536));
  await os.io.write(1, new TextEncoder().encode(text.toUpperCase()));
}
```

`cat README.md | ./upper.js`. Unlike GUI apps, the `node` interpreter **exits
for you when `main` returns** (flushing console output first), and prints
`node: <file>: <message>` to stderr and exits 1 if it throws or fails to load.

## Imports

```js
import { helper } from "./lib.js";      // relative (./ ../) or absolute (/home/me/x.js)
import data from "./data.json";         // JSON as default export
import page from "./page.html";         // HTML as a string: mount(html(page))
import "./style.css";                   // GUI apps only (CLI: error)
import { h, mount } from "os:ui";       // the built-in UI helpers (GUI only)
```

- **No npm, no bare specifiers, no `fetch`**: the sandbox has no network. For
  the internet use `await os.net.fetch("https://…")` (owner only, others get
  `EPERM`).
- **Import cycles are an error** (`ELOOP`): the loader links modules into
  `blob:` URLs, so a module's dependencies must exist first.
- The loader rewrites import statements with a regex
  ([`runtime/jsload.ts`](../src/runtime/jsload.ts)). Known limits (noted in
  the source): it also rewrites matches inside strings/comments and doesn't
  see dynamic `import()`.

How it works: `collect` walks the import graph from your entry, reading each
file with `os.fs`, `link` rewrites each specifier to the `blob:` URL of its
dependency (dependencies first) and `import()`s the entry. That is why the
**user** realm hosts have `blob:` in their `script-src` and the system hosts
don't.

## The manifest

Two equivalent forms; the build step turns the second into the first.

1. **`app.json`** next to the entry (used when running unbundled and by
   `bundle`):

   ```json
   {
     "name": "Notes",
     "icon": "icon.svg",
     "version": "1.0",
     "window": { "width": 480, "height": 320, "translucent": true, "titleBar": "hidden" },
     "commands": [{ "id": "new", "title": "New note", "keywords": ["jot"],
                    "input": { "placeholder": "Note text" } }],
     "handler": "commands.js",
     "search": true
   }
   ```

2. **A `//@app {json}` comment** in the file's first few lines (line 2 of a
   bundle, under the `#!`). It's **read as data, never run**, so Files, the
   desktop and the launcher can show the name and icon without executing
   anything.

Everything in it is **untrusted** and validated by
[`utils/appfile.ts`](../src/utils/appfile.ts): `name` ≤ 64 chars, `window`
sizes clamped (width 160–1920, height 120–1080), `icon` must be a
`data:image/{svg+xml,png,webp,gif,jpeg}` URI ≤ 64 KB and is only ever used as
an `<img src>`, `handler` must be a relative `.js` path inside the app's
folder (no `..`).

`translucent: true` gives a frosted-glass window (make `html, body` background
transparent). `titleBar: "hidden"` lets content run under the title bar; the top
34px stays a drag strip with the window buttons on the left, so put only text
there.

## Shipping: `bundle`

```sh
bundle main.js --install
```

[`bin/bundle`](../src/bin/bundle/main.ts) collects the entry and **everything it
imports** into **one file**, `Notes.app.js`:

- line 1 `#!/ProgramFiles/jsapp` (or `node`),
- line 2 `//@app {…manifest…}`,
- line 3 `export const bundle = {"v":1,"entry":"main.js","modules":{...}};`

Options: `-o out.app.js`, `--name`, `--icon FILE`, `--install`.
`--install` also copies the file to **`~/.local/share/apps/`**, which is where
the app menu, desktop and Spotlight look for installed user apps
(`registry.ts: userApps` reads every `*.js` there, named and iconed by its
manifest; a file with no manifest still appears under its file name).

At run time the loader recognises a bundle (`parseBundle`, reads line 3 as data,
so the embedded sources' own `import`s aren't rewritten by mistake) and serves
modules from the embedded table instead of the filesystem.

Distribution:

- Double-click the `.app.js` in Files to run it.
- Right-click → **Download** to save it outside the OS (`os.shell.download`).
- Upload it into Files anywhere else to run it there.
- To move a whole *project folder*: `tar -czf proj.tgz proj` / `tar -xzf proj.tgz`.

## Spotlight commands for installed apps

Declared in the manifest (`commands`, `handler`, `search`), implemented in the
handler module:

```js
// commands.js: runs headless in a worker: no DOM, no CSS imports, no os:ui.
export async function command(os, id, input) {
  await os.fs.writeTextFile(`${(await os.process.env()).HOME}/note.txt`, input);
  return { message: `Saved “${input}”` };       // or { error: "..." }
}
export async function search(os, query) {        // only with "search": true
  return [{ title: `Jot down: ${query}`, command: "new", input: query }];
}
```

Spotlight runs `/ProgramFiles/jscommand <file.app.js> <id> <input>`;
`jscommand` loads the `handler` module (or the entry if none), calls
`command`, and prints the result as one line of JSON. Everything the
manifest declares is shown only as text, with the app's name beside it. See
[patterns](10-patterns.md#spotlight-commands).

## What a user app can *not* do

User code is **untrusted** (`proc.untrusted`, inherited by everything it
starts, including `sudo`/`su`):

| Blocked | Why |
| ------- | --- |
| `/mnt/cloud` (EACCES) | the owner's private files; untrusted is refused before any root check |
| `os.api.fetch` (EPERM) | would borrow the owner's session cookie |
| network, external images, `localStorage`, popups | CSP / opaque origin |
| all privileged calls | not privileged |

Allowed: its own and world-readable files, `os.net.fetch` if the user is in
the admin group, `spawn`, windows, status items, clipboard, dialogs.
See [security](06-security.md).

## Development loop

1. Create a folder, open it in **Code**, write `main.js`, `app.json`.
2. Press Run (or `./main.js`). Output: terminal or `cat /proc/<pid>/log`.
3. Fix, run again. Errors appear in the window and on stderr.
4. `bundle main.js --install` when it's ready.

`man bundle`, `man sh` and `man open` document the related commands.
