# 2. Processes and executables

## The executable table: `binfmt`

[`src/kernel/binfmt.ts`](../src/kernel/binfmt.ts) is the single source of truth
for "what can be exec'd". It maps an absolute path to a `FileEntry`. Nothing
is discovered at runtime from the filesystem; the files in `/ProgramFiles` and
`/System` are empty placeholders so `ls` works (`core.ts: mountPrograms`).

How the table is built:

| Source | Becomes | Format |
| ------ | ------- | ------ |
| `src/bin/<name>/main.ts` | `/ProgramFiles/<name>` | `worker` |
| `src/apps/<name>/app.ts` (+ `main.ts`) | `/ProgramFiles/<name>` | `iframe` (or `web` if the manifest has a `url`) |
| `src/apps/<name>/commands.ts` | `/ProgramFiles/<name>.commands` | `worker` |
| written by hand in `binfmt.ts` | `/System/*`, `/ProgramFiles/jsapp`, `node`, `jscommand` | any |

```ts
type FileEntry = Flags &
  ( { format?: "module"; load: Executable }                       // in-page
  | { format: "worker"; entry: string; host?: "system" | "user" }
  | { format: "iframe"; entry: string; window: WindowOptions; host?: Host }
  | { format: "web"; url: string; window: WindowOptions } );

type Flags = { privileged?: boolean; setuid?: boolean; admin?: boolean };
```

`entry` is a module path relative to `src/` without extension
(`"bin/cat/main"`). The realm resolves it through an `import.meta.glob`
([`runtime/worker-entry.ts`](../src/runtime/worker-entry.ts) and
[`runtime/iframe-entry.ts`](../src/runtime/iframe-entry.ts)), so **only globbed
files are bundled into each realm**, and DOM-touching app code is never
shipped into workers.

### Flags

| Flag | Meaning |
| ---- | ------- |
| `privileged` | May use system powers: `windows.setPolicy`, `display.root/taskbar/reserveStrut`, `display.claimHotkey`, status-item administration, `api.bindSession`. Reserved for `/System/*`. |
| `setuid` | Runs with euid 0 whoever started it, keeping the caller as real `uid` (`su`, `sudo`, `passwd`). |
| `admin` | Only the admin group may exec it (`mode 0750`, gid 10). Set by `admin: true` in an app manifest. |

## Scripts (`#!`)

If a path is **not** in `binfmt`, `spawn` treats it as a script
(`startScript` in
[`syscalls/process.ts`](../src/kernel/syscalls/process.ts)): the file is read
(with the caller's permissions), its first line must be `#!interpreter [arg]`,
and it runs as `interpreter [arg] script ...args`. The interpreter must itself
be in `binfmt` (no script that runs a script), which also rules out loops.
There's no exec bit for scripts; any readable file with a shebang runs.

| First line | Interpreter | What it is |
| ---------- | ----------- | ---------- |
| `#!/ProgramFiles/jsapp` | iframe, **user** host | a GUI app written in JS |
| `#!/ProgramFiles/node` | worker, **user** host | a CLI program written in JS |
| `#!/ProgramFiles/sh` | worker | a shell script |

The process's shown path (`ps`, taskbar) is the *script's* path, not the
interpreter's.

## Spawning

```ts
const pid = await os.process.spawn("/ProgramFiles/cat", ["file.txt"], {
  fds: { 0: someFd },          // child fd -> parent fd (default: inherit all)
  env: { FOO: "1" },           // merged over the parent's env
  // uid/gid: only when the parent's euid is 0
  // pgid: 0 = new group led by the child; or an existing group in the same session
});
```

`startProcess` does, in order:

1. `resolve(path)` in binfmt (else try as a script).
2. **Exec permission**: `fs.access(path, parent, X)`. Program files carry
   owner/mode like any file (`0755`, admin ones `0750`/gid 10).
3. **Identities** (`childIds`): inherit `uid/euid/gid`; `options.uid` is
   honoured only if the parent's euid is 0; a `setuid` program gets euid 0
   but keeps the caller's real uid.
4. **Process group**: inherit the parent's, unless `pgid` says otherwise
   (joining another session's group is `EPERM`).
5. Allocate the process: `privileged` from the file, **`untrusted`** inherited
   from the parent *or* set if the file runs on the `user` host (VFS code,
   and everything it ever starts, stays untrusted).
6. **File descriptors**: either the explicit mapping or a copy of the parent's
   table (so stdin/stdout/stderr come along).
7. `execute(...)` (async) and emit `process.spawned`.

`spawn` returns as soon as the process is allocated; use `wait` to join it.

### Process fields worth knowing

`pid`, `parentPid`, `pgid`, `sid`, `uid`, `euid`, `gid`, `path`, `args`, `cwd`,
`env`, `status` (`loading | running | stopped | exiting | zombie`), `faults`,
`lastFault`, `files` (fd table), `log` (tail of fds 1/2, readable at
`/proc/<pid>/log`).

The initial environment of everything under a session is `PATH=/ProgramFiles`,
`HOME`, `USER`; they are inherited and can be changed with `os.process.setenv`.

## Lifecycle

```
spawn ──► loading ──► running ──► exiting ──► zombie ──► (reaped)
                         │  ▲
                SIGSTOP  ▼  │ SIGCONT
                       stopped
```

- **Exit**: `os.process.exit(code)`, a signal, or a crash. `main()` returning
  does *not* end a process (GUI apps stay alive; a CLI program must call
  `exit`, which is what the `node` interpreter does for you).
- **Crash**: an exception out of `main()` is reported to the kernel as a
  *fault* (`faultProcess`): the fault is recorded (`faults`, `lastFault`,
  visible in the Process Monitor), and a fault at site `main` terminates the
  process with exit code 134 (`reason: "crash"`).
- **Teardown** (`terminateProcess`): mark `exiting`, abort the process's
  `AbortSignal` (in-flight syscalls reject, the realm gets an `abort`
  message), reap zombie children, reparent living children to pid 0, destroy
  its windows, dispose every registered **resource** (the realm iframe/worker,
  status items, hotkeys, timers, waits), close its fds, drop signal handlers,
  record the termination, become `zombie`, send `SIGCHLD` to the parent, emit
  `process.exited`. A zombie is reaped by the parent's `wait`, or immediately
  if the parent is gone or is the kernel.
- **Resources**: anything that must die with a process is registered with
  `processes.registerResource(pid, kind, dispose)`. Removing the realm's
  iframe *is* the kill: its document unloads and its port closes.

### Waiting

```ts
const status = await os.process.wait(pid);                  // Termination
const maybeStopped = await os.process.wait(pid, { untraced: true });
// status: { code, reason: "exit"|"signal"|"crash", signal?, at }
//      or { code: 128+n, reason: "stopped", signal, at }
```

A process can wait for its own children; privileged processes and euid 0 may
wait for anything. Waiting on yourself is `EINTR`. A pending wait is itself a
resource: if the waiter dies, the wait rejects with `EINTR`.

## Signals

| Signal | Number | Default action | Catchable |
| ------ | ------ | -------------- | --------- |
| `SIGHUP`, `SIGINT`, `SIGTERM` | 1, 2, 15 | terminate | yes |
| `SIGKILL` | 9 | terminate, always | **no** (`onSignal` throws `EINVAL`) |
| `SIGSTOP` | 19 | stop | stop is unconditional |
| `SIGTSTP` | 20 | stop if no handler | yes |
| `SIGCONT` | 18 | resume (and run handler) | yes |
| `SIGCHLD` | 17 | ignore | yes |
| `SIGWINCH` | 28 | ignore | yes |

Exit codes for signal deaths are `128 + number`, like a shell's `$?`.

```ts
const off = await os.process.onSignal("SIGTERM", () => { save(); void os.process.exit(0); });
await os.process.kill(pid, "SIGTERM");      // pid >= 0: one process; pid < 0: group -pid
```

Who may signal whom: the same real/effective user, otherwise the caller must
be the parent, privileged, or euid 0.

A **stopped** process isn't paused at the JS level (JS can't be preempted);
instead *its syscalls park* in `gateStopped` ([`table.ts`](../src/kernel/syscalls/table.ts))
until `SIGCONT`, or reject with `EINTR` if it dies. A call already in flight
finishes.

`SIGHUP` has an app-level meaning too: **Settings broadcasts it when
preferences change**, and apps re-read them (`followAccent`, see
[patterns](10-patterns.md#theming-and-accent)).

## Sessions, groups and terminals

`pgid`/`sid` follow Unix: a shell puts each pipeline in its own group so the
terminal's line discipline can signal the whole job. `setsid()` makes the
caller a session/group leader (a group leader can't). A daemon (see
`bin/timer`) relaunches itself detached and calls `setsid` so closing the
terminal doesn't SIGHUP it.

A pty (`os.io.openpty()`) gives `master` and `slave` fds. The master side (the
Terminal app) writes keystrokes; the **Tty** line discipline edits the line,
echoes, and turns `^C` `^Z` `^D` into `SIGINT`, `SIGTSTP`, EOF for the
foreground group (`tcsetpgrp`). Termios flags: `echo`, `icanon`, `isig`.
Not implemented (noted in the source as `ponytail:` comments): output
processing, `VMIN/VTIME`, `SIGTTIN`.

## Pipes and file descriptors

- fds start at 0/1/2 = stdin/stdout/stderr, inherited from the parent.
- Max 256 per process (`EMFILE`).
- `io.pipe()` → `{ read, write }`; `EPIPE` on writing to a closed pipe.
- `io.dup(fd, to?)` shares one open-file description (offset and flags are
  shared, with a reference count).
- `io.open(path, { read, write, create, truncate, append })`.
- Descriptors to files on the cloud mount are re-checked before each use
  (`remote` flag), because a descriptor outlives the path check that opened it.

Typical CLI I/O is `os.io.read(0, n)` / `os.io.write(1, bytes)`; see
[CLI programs](08-cli-programs.md).

## Hosts: `system` vs `user`

A realm boots on a host page. The `system` host's CSP only lets it run scripts
from the site itself. The `user` host additionally allows `blob:` scripts,
which is how code read from the VFS can be imported (see
[user apps](09-user-apps.md)). Only the JS interpreters (`jsapp`, `node`,
`jscommand`) use it, and everything running there is `untrusted`.
