# 1. Architecture

## Layers

```
src/
├── kernel/      the kernel: runs in the page's own document
│   ├── core.ts            createKernel(): builds everything, mounts filesystems, boots
│   ├── binfmt.ts          THE table of executables (path -> how to run it)
│   ├── proc/              process table, exec, realms, signals, fds, wait, fault handling
│   ├── syscalls/          one file per area; table.ts assembles them; api.ts is the public type
│   ├── wire/              the MessagePort protocol between kernel and realms
│   ├── fs/                VFS, mounts, drivers (memfs, opfs, procfs, remotefs), permissions
│   ├── io/                pipes, ptys, open file descriptions
│   ├── windows/           window manager, snapping, chrome
│   ├── display/           screen, work area, window/overlay layers
│   ├── events/            event bus and event types
│   └── dialog/            the file picker
├── runtime/     what runs INSIDE a realm: wire client, `os` object, boot, JS interpreters
├── System/      privileged system programs: Login, Desktop, Taskbar, Spotlight, Launcher, DebugPs
├── apps/        GUI apps, one folder each (app.ts manifest + main.ts + assets)
├── bin/         command-line programs, one folder each (main.ts), `lib/` shared helpers
├── ui/          theme.css (design tokens), kit.css (native look), kit.ts (`os:ui` helpers)
└── utils/       shared helpers: settings, commands, appfile, filetypes, ...
server/          the small Node backend (login, cloud filesystem, net proxy)
deploy/          Docker/Caddy/deploy scripts
```

## Boot sequence

[`src/main.ts`](../src/main.ts) calls `createKernel(#screen)` then `boot()`
([`core.ts`](../src/kernel/core.ts)):

1. **Construct subsystems**: `Display`, `ProcessManager`, `EventBus`, `VFS`.
2. **Mount filesystems**: `/` (MemFS), `/proc` (ProcFS, read-only), `/home` and
   `/etc` (OPFS if the browser has it, so they survive reloads).
3. **Create the WindowManager** and wire `fs.onChange` to `fs.changed` events
   and work-area changes to `display.workAreaChanged`.
4. **Build the syscall table** (`createSyscallTable(ctx)`) and allocate
   **pid 0**, `/kernel`: privileged, uid 0. The kernel's own `os` is bound to it.
5. `boot()`:
   - `mountPrograms`: expose every binfmt path as an empty read-only file in
     `/ProgramFiles` and `/System` so `ls` and tab completion see them; set
     their modes (`0755`, or `0750` + admin group for admin-only programs).
   - create `/tmp` (`0777`) and `/mnt`, mount the **cloud filesystem** at
     `/mnt/cloud` (a `RemoteFS`; permissions fixed and admin-only).
   - load saved file attributes (owner/mode) from browser storage.
   - seed `/etc/autostart` if missing or still an old default.
   - `spawn("/System/login")`.
6. **Login** (privileged, runs as root forever) shows the user picker and, once
   authenticated, spawns `/System/desktop` as that user. When the desktop exits
   (logout) it tears the session down and shows the picker again.
7. **Desktop** (in-page) draws the wallpaper and icons, then reads
   `/etc/autostart` and `~/.config/autostart` and spawns each line in order:
   Taskbar, Spotlight, `launcher` (opens `?launch=` apps), `calsync`, `session`.

## Three kinds of process

All three are processes (a pid, a uid/gid, fds, an env, signals). They differ
in where their code runs. The `binfmt` entry decides which:

| `format`   | Realm | Typical use | Has DOM? | Has a window? |
| ---------- | ----- | ----------- | -------- | ------------- |
| *(module)* | In-page, inside the kernel's document | `Desktop`, `Taskbar`, `Login`: things that must draw into the kernel's own DOM | the kernel's | via `os.display.root()` |
| `worker`   | Web Worker inside an invisible sandboxed iframe | every CLI program in `bin/`, headless `commands.ts`, `launcher` | no | no |
| `iframe`   | Sandboxed iframe placed *inside* a window the kernel creates | every GUI app, Spotlight, Process Monitor | its own | exactly one |
| `web`      | A cross-origin site framed into a window | wrapping an external site (`url` in `app.ts`) | the site's | one |

Only in-page programs are fully trusted code. Everything else is untrusted by
construction and must go through the wire.

## The wire

Realms cannot call kernel functions. Each realm gets one `MessagePort` at boot
and a client ([`runtime/client.ts`](../src/runtime/client.ts)) that turns
`os.fs.readFile(p)` into `{ t: "call", id, call: "fs.readFile", args: [p] }`.
The kernel side ([`wire/server.ts`](../src/kernel/wire/server.ts)):

1. parses the message (`parseAppMessage`),
2. checks the name is an own key of `WIRE_CALLS` (so `constructor`,
   `__proto__` can never resolve),
3. maps it to a `SyscallTable` method and calls it **with the process's pid**,
   never with a pid supplied by the realm,
4. replies `ok` / `err` (errors keep their `code`, e.g. `ENOENT`).

Functions passed as arguments (event handlers, signal handlers, menu
callbacks) are replaced by `{ $cb: id }` references; the kernel calls them back
with `cb` messages. Dropping the returned disposer sends `release`.

`WIRE_CALLS` is checked at compile time against `AppInterface` and the
`SyscallTable` signatures (`WireCallsAligned` in
[`protocol.ts`](../src/kernel/wire/protocol.ts)): if you add an API member and
forget to wire it, or wire it with mismatched arguments, `tsc` fails. That is
the "wire-safety check" CI refers to.

## Where each thing is decided

| Question | Answer lives in |
| -------- | --------------- |
| What programs exist and how do they run? | `kernel/binfmt.ts` |
| What can a program ask the kernel? | `kernel/syscalls/api.ts` (`AppInterface`) |
| May *this* process do it? | the syscall's file + `syscalls/guards.ts` + `fs/perm.ts` |
| How does the call get there? | `kernel/wire/protocol.ts` (`WIRE_CALLS`), `runtime/os.ts` |
| Where do a realm's modules load from? | `runtime/iframe-entry.ts`, `runtime/worker-entry.ts` (globs) |
| What's the sandbox/CSP? | `vite.config.ts` (`realmCsp`), `kernel/proc/realm.ts` |

## Version

`PortfolioOS` v4.0 (`src/kernel/version.ts`).
