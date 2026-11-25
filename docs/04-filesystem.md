# 4. Filesystem

One tree, one API, several backends. Programs see only `os.fs` and `os.io`.
Which backend answers is decided by **mounts**.

## The mount table

Built in [`core.ts`](../src/kernel/core.ts):

| Mount | Driver | Persistent? | Writable | Contents |
| ----- | ------ | ----------- | -------- | -------- |
| `/` | `MemFS` | no (memory) | yes | the skeleton |
| `/proc` | `ProcFS` | n/a (live) | **read-only** | processes and mounts |
| `/home` | `OpfsFS("home")` | **yes**, per browser profile | yes | user homes |
| `/etc` | `OpfsFS("etc")` | yes, per browser profile | yes | passwd, group, shadow, autostart |
| `/ProgramFiles`, `/System` | `MemFS` placeholders | no | **read-only** | one empty file per program in `binfmt` |
| `/tmp` | on `/` (MemFS), mode `0777` | no | yes | scratch |
| `/mnt/cloud` | `RemoteFS("/api/private/fs")` | **yes**, on the server, same in every browser | yes | the owner's files |

If the browser has no OPFS, `/home` and `/etc` fall back to memory (the
System Info app says which).

Path lookup picks the **longest matching mount prefix**
([`fs/mount.ts`](../src/kernel/fs/mount.ts)). Mount points that are children of
a directory are merged into its `readdir`, so `/mnt/cloud` appears in `ls /mnt`
even though it lives in another driver.

## Drivers

All implement `FileSystemDriver`
([`fs/fsdriver.ts`](../src/kernel/fs/fsdriver.ts)): an inode-style interface
over opaque `Node`s.

```ts
interface FileSystemDriver {
  root(); lookup(parent, name); stat(node); readdir(node);
  read(node, offset, length); write(node, offset, data); truncate(node, size);
  create(parent, name, kind); rmdir(parent, name); unlink(parent, name);
  rename?(fromParent, fromName, toParent, toName);   // throw EXDEV when it can't
  open?(node, path): Promise<OpenFile>;               // for non-regular files
}
```

| Driver | Notes |
| ------ | ----- |
| `MemFS` | plain in-memory tree |
| `OpfsFS` | the browser's Origin Private File System; maps `ENOSPC` from quota errors. OPFS can't store owner or mode, so the VFS keeps those separately (below). |
| `ProcFS` | generated on read: `/proc/uptime`, `/proc/version`, `/proc/mounts` (`<type> <path> <ro\|rw>`), and per process `/proc/<pid>/{status,cmdline,cwd,environ,log}` plus `/proc/<pid>/fd/<n>`. Strict numeric names (`007` doesn't alias pid 7). |
| `RemoteFS` | talks to `server/` over `/api/private/fs/{list,stat,usage,read,write,mkdir,remove,move}`. Max file size 20 MiB (`EFBIG`); server quota is `ENOSPC`. |

## Permissions

Unix-style bits, pure logic in
[`fs/perm.ts`](../src/kernel/fs/perm.ts):

- Every node has `{ uid, gid, mode }`. Checks use the caller's **effective**
  uid and its single group: owner bits if `euid == uid`, else group bits if
  `gid` matches, else other bits. **euid 0 passes everything.**
- Directories need `x` to be traversed (every ancestor is checked: "search")
  and `r` to be listed; creating/removing entries needs `w`.
- Default attributes: files `0644`, directories `0755`, owned by root unless a
  directory above has an entry (then it inherits that owner), which is how
  files that appeared in OPFS behind the kernel's back end up owned by the
  home's owner.
- No umask, no sticky bit, one group per process (marked `ponytail:` in the
  source as known simplifications).
- Program files are real nodes with modes: `0755`; admin-only programs
  `0750` with group `10` (`ADMIN_GID`). `spawn` checks `X` on them.
- `chmod`: owner or root. `chown`: root only.

Attributes for `/home` and `/etc` are persisted to a `meta.json` in the OPFS
root, outside every mount, so no process can read or edit it (`fs/meta.ts`).
They're saved debounced (300 ms) whenever they change.

### The credential

The VFS takes a `Cred = { uid, euid, gid, untrusted }`. A `Process` *is* a
`Cred`. Every VFS method defaults to `ROOT`, which is why `untrusted` is
required rather than optional: forgetting to pass a credential must not
silently grant everything. Syscalls always pass the calling process.

## The cloud mount (`/mnt/cloud`)

A remote mount is "the owner's private API wearing a directory's clothes". The
rules, enforced in the VFS before any other check (in `mountFor`), are:

1. **Untrusted code is refused** (`EACCES`): anything from the VFS and
   everything it starts. This check runs *before* the euid-0 shortcut because
   `untrusted` is inherited but euid 0 is one `su` away.
2. **Only the signed-in session's user**: the caller's *real* uid must equal
   the uid Login bound with `api.bindSession`. `sudo` keeps the real uid (still
   the owner); `su root` replaces it (no longer the owner).
3. **Permissions are fixed, never stored**: directories `0770`, files `0660`,
   uid 0, gid 10 (admin) at every depth. `chmod`/`chown` are `EPERM`.
   (Stored per-browser attrs would differ between the very browsers the mount
   exists to keep in sync.)
4. `fs.changed` for remote paths is delivered only to processes that pass the
   same two checks (otherwise events would leak file names).
5. The backend checks the session cookie on every request anyway; the client
   side is not *the* protection.

Consequence for app authors: **a non-owner (or signed-out) user's access to
`/mnt/cloud` fails with `EACCES`.** Apps that use it must have a local
fallback and must not branch on *who* is running, only on whether the mount
accepts them. Both Todo and Calendar do this; see
[patterns](10-patterns.md#storage-cloud-with-a-local-fallback).

## The user layout

```
/home/<user>/
  .config/                 per-user config (settings.json, todo.json, calendar.json, ...)
    autostart              programs the desktop starts at login, one path per line
  .local/share/apps/       installed user apps (*.app.js from `bundle --install`)
  .Trash/                  the Bin (+ .info/<name>.json with original paths)
  Desktop/ Documents/ Downloads/ Pictures/ ...
  Projects/<folder>/       Projects app notes (when not using the cloud)
/etc/
  passwd  group  shadow    the user database (plain text; the kernel only knows numbers)
  autostart                system-wide autostart, one path per line
```

Conventions:

- **`~/.config/<app>.json`** (or `~/.config/<app>/`) for per-user state.
- Dot-files and dot-folders are hidden from the file picker and from Spotlight's
  file search.
- `$HOME` is in the process env; never hard-code `/home/<name>`.

## Whole-file vs descriptor I/O

- `os.fs.readFile/writeFile` open, transfer everything, close. There is no
  atomic rename-over guarantee across drivers, so apps that need safe updates
  do **read-modify-write of the latest copy** (see Todo's `store.update`).
- `os.io.open/read/write/seek` give descriptor semantics and are what the
  shell, pipes and CLI tools use.
- After a write session closes the VFS calls `onChange(path)`, which becomes an
  `fs.changed` event; a rename fires it for both the old and the new path.
  Subscribers hear it only for directories they could list, so one `fs.changed`
  handler is enough to keep a window in step with other writers.

## `rename` across mounts

`rename` is within a single mount and throws `EXDEV` otherwise. Copy + unlink
instead (`utils/tree.ts` has `moveTree`/`removeTree` helpers that Files and the
Bin use).

## What you can inspect from the terminal

```sh
cat /proc/mounts          # type (opfs|proc|remote|mem), path, ro/rw
cat /proc/42/status       # state, ids, faults
ps                        # processes
ls /proc/42/fd            # open descriptors of pid 42
cat /proc/42/log          # tail of what pid 42 printed (no terminal for GUI apps)
stat /home/me/.config
```
