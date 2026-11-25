# 10. App patterns and conventions

Recipes the existing apps share. Following them makes a new app behave like
the rest of the OS.

## Per-user configuration

Per-user state lives under `~/.config`. Helpers in
[`utils/settings.ts`](../src/utils/settings.ts):

```ts
const settings = await loadSettings(os);     // ~/.config/settings.json merged over DEFAULTS
const dir = await ensureConfigDir(os);       // creates ~/.config if needed, returns its path
await os.fs.writeTextFile(`${dir}/myapp.json`, JSON.stringify(data, null, 2) + "\n");
```

`Settings` covers wallpaper, accent, clock format, dock behaviour, snapping,
avatar and `openWith` (extension → default program). Only the Settings app
writes `settings.json`. Your own state goes in your own file
(`~/.config/<app>.json`, or a folder `~/.config/<app>/`), never in
`settings.json`.

Parse files defensively: they may be missing (`ENOENT`), hand-edited, or from an
older version. Merge over defaults, clamp numbers, cap array sizes (Todo's
`parseData`, `MAX_TODOS`, `MAX_TITLE`). A corrupted file should degrade to
defaults, never crash the app.

## Theming and accent

Colours come from CSS variables defined in
[`ui/theme.css`](../src/ui/theme.css): `--app-bg`, `--app-surface`,
`--app-surface-hi`, `--app-well`, `--app-border`, `--app-border-hi`,
`--app-text`, `--app-text-dim`, `--app-text-faint`, `--app-accent`,
`--app-accent-soft`, `--app-ok`, `--app-warn`, `--app-danger`,
`--app-danger-soft`, plus `--app-radius`, `--app-radius-sm`, `--app-row`,
`--app-control`, `--app-sans`, `--app-mono`, `--app-shadow`. Use them; don't
hard-code colours, so a new accent or theme change reaches your app.

The **accent** is user-chosen, so:

```ts
await followAccent(os);
```

does two things: applies the accent now, and registers a `SIGHUP` handler that
re-reads settings and re-applies it. The Settings app then notifies running
apps by sending `SIGHUP`, **but only to the programs it lists**
(`RELOAD_ON_HUP` in `src/apps/settings/main.ts`), because SIGHUP's default
action is to *kill* a process. Consequences:

- If you call `followAccent`, add your app's id to `RELOAD_ON_HUP` so it live-updates.
- If you register your own `SIGHUP` handler for another reason, same: you have
  to be in the list to receive it, and you must not leave the default in place
  for a program that isn't listed.

## Storage: cloud with a local fallback

For the owner's data that should follow them between browsers (todos,
calendars, projects), the pattern is in `src/apps/todo/store.ts`,
`calendar/store.ts` and `projects/store.ts`:

1. **Try the cloud mount** (`/mnt/cloud/<app>/...`): `mkdir`, then read. If it
   works, `backing = "cloud"`. If the cloud file doesn't exist yet, **seed it
   from the local copy** so data kept before signing in isn't left behind.
2. **On any failure** (`EACCES` for a visitor or signed-out user, no server,
   etc.), use `~/.config/<app>.json` and `backing = "local"`.
3. **Never branch on who the user is.** Decide by *trying the mount*, not by
   calling `os.process.ids()`. That keeps behaviour identical for everyone and
   never reveals that an owner account exists.
4. Tell the user where the data lives (the sidebars name the storage) and
   word save errors by backing: `ENOSPC` → "no room left", cloud `EACCES` →
   "Signed out: couldn't save", otherwise "Couldn't save. Try again."

## Read-modify-write, always

Several processes (a window, another browser, a headless Spotlight command, the
Calendar editing Todo's file) may write the same file. So every change is:

```ts
await store.update((data) => { data.todos.push(todo); });
// internally: read the LATEST copy from disk → apply `change` → write back
```

Rules (from Todo's `TodoStore`):

- **Apply the change to the latest on-disk copy**, not to what you rendered
  earlier. Two browsers editing the same calendar then don't undo each other.
- Queue changes behind one another (`queue.then(run, run)`) so two quick
  actions never race.
- Show the change **optimistically** (update `data` at once), then reconcile:
  if the write fails, re-read the file so nothing on screen isn't on disk.
- The `change` callback runs *twice* (on the screen copy and on the disk copy),
  so it must be **deterministic**: create ids and timestamps *outside* it.
- Skip the write if the serialised result equals what's on disk.

## Following other writers: `fs.changed`

```ts
await os.events.subscribe(["fs.changed"], (event) => {
  if (event.path === store.path) void pull();      // someone wrote our file
});
await os.timers.setInterval(() => void pull(), 60_000);  // other browsers + day rollover
```

`fs.changed` fires for writes made by *this* browser's processes (and only for
directories you could list). Another browser's edits to the cloud mount raise no
event here, so also poll lightly (Todo and Calendar tick each minute, which is
also when "today" rolls over).

## Cross-app data

Apps cooperate through **files with a documented shape**, not APIs:

- The **Todo** file (`todo.json` / `/mnt/cloud/todo/todos.json`) is read by Todo,
  the Calendar (draws planned todos, ticks them off) and Projects (goals and
  parts are ordinary todos carrying `project`, `goal`, `parent`).
- Calendars are `.ics` files (one per calendar) in
  `/mnt/cloud/calendar/mine/` or `~/.config/calendar/mine/`, so they open and
  import anywhere.
- Notes are markdown files in per-project folders, so Code and Files open them.

Keep such files human-readable and forward-compatible (unknown fields are
preserved), and write their shape into `PRODUCT.md`.

## Spotlight commands

Spotlight (Cmd/Ctrl+K) lists apps, windows, files and **commands that apps
declare as data**. Nothing runs until the user picks one.

Manifest (built-in: `app.ts`; installed: `//@app`/`app.json`):

```ts
commands: [
  { id: "new", title: "New todo", keywords: ["add", "task"],
    input: { placeholder: "What needs doing?", required: true } },
  { id: "done", title: "Mark done", hidden: true },     // reachable only from search results
],
search: true,
```

[`CommandSpec`](../src/utils/commands.ts): `id` (`[a-z0-9-]`, ≤ 32), `title`,
optional `keywords`, `input` (makes Spotlight's field become this command's
input), `hidden`. Max 16 commands per app. Everything is validated and capped;
Spotlight displays it as text with the app's name next to it.

Handler (`commands.ts`, a worker, or the installed app's `handler`):

```ts
export const command: CommandHandler = async (os, id, input) => ({ message: "Done" });
export const search: SearchHandler = async (os, query) =>
  [{ title: "Buy milk", detail: "tomorrow", command: "done", input: "<todo id>" }];
export const main = commandMain(command, search);        // built-in apps only
```

Results: `{ message }` (shown, then Spotlight closes), `{ error }` (shown,
stays open), `{ open: [args] }` (start the app afterwards). Search returns up
to 8 `{ title, detail?, command, input? }`; choosing one runs that command.

Under the hood, running a command is **running a program, headless, as the
user**: `/ProgramFiles/<app>.commands <id> <input>` (or `jscommand`), whose
stdout is one JSON line that Spotlight reads from a pipe. The handler has
exactly the powers its app has; there is no new kernel permission.

The Todo commands parse natural language (`call mum fri 14:00 for 30m`); keep
that parsing in a pure module (`parseQuickAdd`) shared by the app and the
handler, with a `*.check.ts`.

## Top-bar status items

Use `os.display.addStatusItem` for glanceable state (a countdown, the next
event, a score). Keep the icon a tiny inline SVG, update `label` rather than
re-adding, and give the menu a "Quit" if the item outlives a window. See
[windows](05-windows.md#status-items-top-bar-extras).

## Phones and narrow windows

At phone width (`max-width: 700px`, or coarse pointer ≤ 1024px) every window
is fullscreen with no drag/resize. Design for both:

- Use CSS container/media queries (`matchMedia("(max-width: 560px)")` as
  in Aliases, with the same number in your CSS: keep the two in sync and
  comment it).
- Multi-column layouts become a **drill-down** (Projects).
- Minimum window sizes in `app.ts` should be small enough to be usable.
- Hit targets ≥ ~30px (`--app-row`).
- Never use a native `<input type="date">` or other pickers that need a browser
  popup the sandbox can't open (Projects builds its own small month); likewise
  no `alert/confirm/prompt`: build confirmation into the UI (`utils/confirm.ts`
  is a themed modal `<dialog>` stand-in for `confirm()`; note that sandboxed
  frames have no `allow-forms`, so don't rely on `<form method="dialog">`).

## Accessibility and motion

- Respect `prefers-reduced-motion` (Todo skips its celebration).
- Keep focus visible (`kit.css` has a `:focus-visible` ring using the accent).
- Provide keyboard paths for primary actions, and avoid the system-reserved keys
  ([windows → hotkeys](05-windows.md#system-hotkeys)).

## Time, dates and recurrence

The Calendar is the reference: dates are stored in the device's IANA zone;
repeating events implement a deliberate **subset** of RFC 5545 (daily/weekly/
monthly/yearly, `INTERVAL`, `BYDAY` with ordinals, `BYMONTH`, `BYMONTHDAY`,
`COUNT`, `UNTIL`, `WKST`, `EXDATE`/`RDATE`, `RECURRENCE-ID`; no `BYSETPOS`),
because that keeps occurrence generation ascending and the windowed walk
correct. Prefer a documented subset over a half-implemented standard.

## Dependencies

Built-in apps may import npm packages (they're bundled). Prefer none. Current
runtime deps: CodeMirror (Code), `marked` (Reader), `pdfjs-dist`
(Reader), `otpauth` (server). Anything you add ships in every user's bundle and
runs under the realm CSP, so avoid libraries that fetch, inject remote
scripts/fonts or need `eval`.
