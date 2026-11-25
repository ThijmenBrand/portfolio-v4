# 3. Syscall reference

Every program receives `os` as the first argument of `main(os, args)`. Its
type is `AppInterface` in
[`src/kernel/syscalls/api.ts`](../src/kernel/syscalls/api.ts). All methods are
async (they cross a `MessagePort`), except `os.process.signal` and
`os.process.pid`, which are local properties.

Errors reject with a `KernelError` that has a stable `code`
(`ENOENT`, `EACCES`, ...; see [Errors](#errors)). Always branch on
`error.code`, not on the message.

```ts
import type { AppInterface } from "../../kernel/syscalls/api";
export async function main(os: AppInterface, args: string[]) { ... }
```

In-page system programs get a `SystemInterface`, which extends this with a few
privileged members (marked **[priv]** below).

---

## `os.fs`: whole-file operations

Paths are resolved against the process's `cwd`. All checks use the caller's
identity (see [Filesystem](04-filesystem.md)).

| Call | Notes |
| ---- | ----- |
| `readFile(path): Bytes` | |
| `writeFile(path, data: Bytes)` | creates or truncates; needs write on the file (create: write on the directory) |
| `readTextFile(path): string` | UTF-8; implemented in the realm on top of `readFile` |
| `writeTextFile(path, text)` | likewise |
| `readdir(path): DirEntry[]` | `{ name, kind, size, createdAt, modifiedAt, readonly, uid, gid, mode }` |
| `stat(path): StatResult` | `{ kind, size, createdAt, modifiedAt, readonly, uid, gid, mode }` |
| `mkdir(path)` | `EEXIST` if present |
| `unlink(path)` / `rmdir(path)` | `rmdir` is `ENOTEMPTY` on a non-empty dir |
| `rename(from, to)` | within one mount; **`EXDEV` across mounts**: copy then unlink |
| `chmod(path, mode)` | file owner or root; mode is masked to `0o777` |
| `chown(path, uid, gid)` | root only |
| | both are **always `EPERM` on the cloud mount** (fixed permissions) and `EROFS` on read-only mounts |

`kind` is `"file" | "directory" | "fifo"`. `Bytes` is `Uint8Array<ArrayBuffer>`.

## `os.io`: descriptors, pipes, terminals

| Call | Notes |
| ---- | ----- |
| `open(path, flags): fd` | `flags: { read?, write?, create?, truncate?, append? }` |
| `close(fd)` | |
| `read(fd, length): Bytes` | an **empty** result means EOF |
| `write(fd, data): number` | bytes written |
| `seek(fd, offset, whence = "set")` | `"set" \| "cur" \| "end"`; `ESPIPE` on pipes/ptys |
| `dup(fd, to?): fd` | shares offset and flags |
| `fstat(fd): Stat` | |
| `listFds(): FdInfo[]` | what `/proc/<pid>/fd` shows |
| `pipe(): { read, write }` | |
| `openpty(): { master, slave }` | |
| `tcgetattr(fd)` / `tcsetattr(fd, changes)` | `Termios { echo, icanon, isig }` |
| `tcgetpgrp(fd)` / `tcsetpgrp(fd, pgid)` | foreground group, where `^C` goes |
| `getWinsize(fd)` / `setWinsize(fd, { rows, cols })` | resizing signals `SIGWINCH` |

## `os.process`

| Member | Notes |
| ------ | ----- |
| `pid` | local, synchronous |
| `signal` | local `AbortSignal`-like: aborts when the process is being terminated; `signal.reason` is the signal name or `exit`/`crash` |
| `spawn(path, args?, options?): Pid` | see [Processes](02-processes.md#spawning) |
| `wait(pid, { untraced? }): WaitStatus` | |
| `exit(code = 0)` | |
| `kill(pid, signal)` | negative pid targets a group |
| `onSignal(signal, handler): disposer` | not for `SIGKILL` |
| `list(): ProcessInfo[]` / `history(): ExitRecord[]` | the last 50 exits |
| `chdir(path)` / `cwd()` | |
| `env()` / `setenv(name, value?)` | `value` omitted deletes; empty name or `=` is `EINVAL` |
| `ids(): { uid, euid, gid, pgid, sid }` | |
| `setsid(): Pid` | `EPERM` for a group leader |

## `os.windows`

See [Windows and display](05-windows.md) for the model.

| Call | Notes |
| ---- | ----- |
| `create(options): WindowHandle` | In a realm this **claims** the window the kernel already made at exec (one per process; a second call is `EINVAL`). In-page it makes a new window and returns an `ElementWindowHandle` with a `body` element. |
| `list(): WindowInfo[]` | only windows the caller may arrange (own, same user's, or all if privileged/root) |
| `focus(id)`, `setMinimized(id, bool)`, `close(id)` | |
| `tile(id, target)` | `target`: `"left" \| "right" \| "top-left" \| "top-right" \| "bottom-left" \| "bottom-right" \| "maximize" \| "restore"` |
| `setTitle(id, title)` | |
| `onCloseRequest(id, cb)` | registering a handler replaces the default close; see below |
| `setSize(id, {width?,height?})`, `setFrame(id, rect)`, `setVisible(id, bool)` | `setVisible` is for overlays |
| `setPolicy({ snap })` **[priv]** | |

`WindowOptions`: `title`, `width`, `height`, `x`, `y`, `minWidth`,
`minHeight`, `maxWidth`, `maxHeight`, `translucent`, `titleBar:
"default" | "hidden"`, `surface: "window" | "overlay"` (surface is fixed at
exec, in binfmt).

`WindowHandle`: `{ id, setTitle(t), close(), onCloseRequest(cb) }`.

## `os.display`

| Call | Notes |
| ---- | ----- |
| `workArea(): Rect` | the screen minus taskbar/struts; updates arrive as `display.workAreaChanged` |
| `addStatusItem(spec, onSelect): id` | a top-bar icon + menu; max 5 per process |
| `updateStatusItem(id, patch)` / `removeStatusItem(id)` | only your own |
| `claimHotkey(name, onPress)` | **privileged only**; only `"palette"` (Cmd/Ctrl+K) exists |
| `root()`, `taskbar()`, `reserveStrut(edge, size)`, `releaseStrut(id)`, `listStatusItems()`, `activateStatusItem(id, menuId)` | **[priv]**, in-page only |

`StatusItemSpec`: `{ icon: "<svg …>" (≤ 8 KB, must start with <svg), title (≤ 64),
label? (≤ 32), menu?: StatusMenuItem[] (≤ 20) }`;
`StatusMenuItem`: `{ id, label, disabled?, checked? }` or `{ separator: true }`.

## `os.events`

```ts
const off = await os.events.subscribe(["fs.changed", "window.focused"], (e) => { ... });
await off();                       // or let process exit clean it up
```

| Event | Fields |
| ----- | ------ |
| `process.spawned` | `pid, parentPid, path, at` |
| `process.exited` | `pid, parentPid, path, startedAt, termination` |
| `window.created` / `.destroyed` | `pid, windowId, (title)` |
| `window.titleChanged` | `pid, windowId, title` |
| `window.focused` | `pid, windowId` |
| `window.minimized` | `pid, windowId, minimized` |
| `window.stateChanged` | `pid, windowId, state, tile?, frame` |
| `display.workAreaChanged` | `area` |
| `display.statusChanged` | (status items changed) |
| `fs.changed` | `path` |

Delivery is **filtered**:

- Non-privileged processes only see `process.*`/`window.*` events about
  *themselves* (events carrying a `pid` different from yours are dropped).
- `fs.changed` is delivered only if you could `readdir` the changed path's
  parent directory.
- An exception thrown from your handler is recorded as a fault of site `event`.

## `os.timers`

`setInterval(cb, ms): id` / `clearInterval(id)`. In realms these run **locally**
(plain `setInterval` in your realm); they die with the realm. The kernel-side
registration only matters for in-page programs. You can also use ordinary
`setTimeout`/`setInterval`/`requestAnimationFrame` in a realm.

## `os.shell`

| Call | Notes |
| ---- | ----- |
| `openExternal(url)` | opens a new browser tab. **https: and mailto: only**; the browser requires a recent user click. This is the only way to open a link. |
| `location(): { href, pathname, search, hash }` | read-only page URL. Treat as untrusted input (anyone can craft a link). There is deliberately no way to change it. |
| `download(path)` | hands a VFS file to the browser as a download (`application/octet-stream`), read with the caller's permissions |

## `os.clipboard`

`writeText(text)` (≤ 1 MiB) and `readText()`. Reading requires recent user
activation (a click or keypress, including one inside your iframe) or it is
`EPERM`. The kernel also keeps its own copy so copy/paste between apps works
even when the browser refuses the system clipboard.

## `os.dialog`

```ts
const path = await os.dialog.open({ kind: "file", title: "Open", startIn: "/home/me" });
// kind: "file" | "directory" | "save"; "save" also takes `name`; resolves null on cancel
```

The kernel draws the picker as a sheet over your window and browses with
**your** credentials, so it never shows more than you could read. One dialog
per process at a time (`EBUSY`). Dot-files are hidden.

## `os.api`

`api.fetch(path, { method?, body? }): { status, body: string }`: a request to
the OS's own backend (`/api/...` on the same origin; JSON bodies). The kernel
makes it, carrying the session cookie. **Allowed only** for trusted processes
whose *real uid* is the signed-in user (or privileged system programs such as
Login). Code that came from the VFS is always refused. Most apps never need
this; they use `/mnt/cloud` through `os.fs` instead.

`api.bindSession(uid)` **[priv]**: Login tells the kernel who signed in.

## `os.net`

`net.fetch(url, { method?, body?, contentType? }): { status, contentType, body: Bytes }`
fetches an `https:` URL through the backend (which refuses private
addresses). **Admin group / root only**, and the backend independently
requires an owner session. No cookies or caller headers are forwarded. Failure
to reach it is `EPERM` (not authorised) or `EIO`.

---

## Errors

`KernelError { code, message, details? }`. Codes in use:

| Code | Meaning |
| ---- | ------- |
| `ENOENT` | no such file/dir/path |
| `EEXIST` | already exists |
| `ENOTDIR` / `EISDIR` | wrong kind |
| `ENOTEMPTY` | directory not empty |
| `EACCES` | permission denied on a path |
| `EPERM` | operation not permitted (privilege, identity, gate) |
| `EROFS` | read-only filesystem |
| `EXDEV` | cross-mount rename |
| `EBADF` | bad file descriptor |
| `EMFILE` | too many open files (256) |
| `EPIPE` | writing to a closed pipe |
| `ESPIPE` | seek on a non-seekable fd |
| `ENOTTY` | not a terminal |
| `EBUSY` | resource busy (e.g. a dialog is already open) |
| `EFBIG` / `ENOSPC` | too large / out of space |
| `EINVAL` | bad argument |
| `EINTR` | interrupted (process died while waiting, or SIGKILL while stopped) |
| `ESRCH` | no such (live) process |
| `ENOEXEC` | not executable / no usable interpreter / no `main` |
| `ENOSYS` | no such syscall |
| `ENODEV` | no such window / device |
| `EIO` | other I/O failure |

Helper constructors (`enoent(path)`, `eperm(pid, syscall)`, ...) are in
[`kernel/errors.ts`](../src/kernel/errors.ts).

## Typical idioms

```ts
// Is it missing, or really broken?
const text = await os.fs.readTextFile(p).catch((e) => {
  if ((e as { code?: string }).code === "ENOENT") return null;
  throw e;
});

// Home folder
const home = (await os.process.env()).HOME ?? "/";

// Run a program and wait for it
const pid = await os.process.spawn("/ProgramFiles/files", [dir]);
const { code } = await os.process.wait(pid);

// Stop cleanly on SIGTERM
await os.process.onSignal("SIGTERM", () => void os.process.exit(0));
```
