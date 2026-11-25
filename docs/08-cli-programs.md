# 8. Building a command-line program

CLI programs are the OS's `/usr/bin`: `ls`, `cat`, `grep`, `sed`, `tar`, `curl`,
`ps`, `kill`, `sudo`, ... One folder per program in `src/bin/`, run as a
**worker** in an invisible sandboxed frame. No DOM, no window; standard I/O is
file descriptors 0, 1 and 2.

## Anatomy

`src/bin/<name>/main.ts`: that's all it takes. `binfmt.ts` globs
`src/bin/*/main.ts` and registers `/ProgramFiles/<name>`; `worker-entry.ts`
globs the same files into the worker bundle.

```ts
// src/bin/upper/main.ts: uppercase stdin (or the named files)
import type { AppInterface } from "../../kernel/syscalls/api";
import { print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const { text, ok } = await readInput(os, "upper", args);   // stdin if no args
  await print(os, 1, text.toUpperCase());
  await os.process.exit(ok ? 0 : 1);
}
```

Then, in the terminal: `echo hi | upper` or `upper notes.txt`.

### Rules

1. **Always end with `os.process.exit(code)`.** Returning from `main` leaves the
   process running (the shell would wait forever).
2. **stdout is fd 1, stderr fd 2.** Write bytes: `os.io.write(1, new TextEncoder().encode(...))`
   (the `print` helper does this).
3. **Read stdin until an empty chunk** (that is EOF). Don't assume one `read`
   returns everything: pipes deliver chunks. Use `readFd`/`readInput` from
   [`bin/lib/input.ts`](../src/bin/lib/input.ts), which decode with
   `{ stream: true }` so multi-byte characters split across chunks survive.
4. **Errors**: print `name: path: CODE` to stderr and continue/exit non-zero
   (`errorCode(error)` gives `ENOENT` etc.). Don't throw out of `main` for
   expected failures: an uncaught exception is a *crash* (exit 134, a recorded
   fault).
5. **Exit codes**: 0 success, 1 failure, 2 usage error (convention used by
   existing tools).
6. **Pure byte copying shouldn't decode.** `cat` pumps `Uint8Array`s untouched.
7. **No imports from `src/apps/*`** that touch the DOM; the worker bundle has no
   DOM. Share logic through `src/bin/lib/` or `src/utils/`.
8. Relative paths resolve against `cwd`, which the shell sets (`os.process.cwd()`).

### Useful shared helpers (`src/bin/lib/`)

| Module | Provides |
| ------ | -------- |
| `input.ts` | `print`, `readFd`, `readInput`, `lines`, `errorCode` |
| `path.ts` | path helpers for tools |
| `users.ts` | read/write `/etc/passwd`, `group`, `shadow` (used by `su`, `sudo`, `useradd`, `passwd`, Settings) |
| `diff.ts`, `sed.ts`, `ustar.ts`, `size.ts`, `dev.ts` | the pure engines behind `diff`, `sed`, `tar`, `du/df`, the dev tools |
| `vim.ts` | the editor engine behind `vim`: keys in, a screenful out. Full-screen programs (`less`, `vim`) use the alternate screen (`ESC[?1049h`), `tcsetattr` with `icanon:false` for single keys, and may use SGR 7 / 100 for cursor / selection |

Put the **logic in a pure module** with no `os` and no DOM, and keep
`main.ts` thin. That's what makes the `*.check.ts` self-tests possible (they
run in plain Node).

## Daemons and top-bar extras

A program can keep running without a terminal. `bin/timer` is the pattern:

```ts
if (args[0] !== "--bg") {
  await os.process.spawn("/ProgramFiles/timer", ["--bg"]);   // relaunch detached
  await print(os, 1, "timer: running in the top bar\n");
  return os.process.exit(0);                                 // give the shell its prompt back
}
await os.process.setsid().catch(() => {});                   // closing the terminal won't SIGHUP us
const item = await os.display.addStatusItem({ icon, title: "Timer", menu }, (id) => { ... });
```

(A worker can use `os.display.addStatusItem` too; status items are a
kernel-rendered UI primitive, not DOM.)

## Pipelines, redirects, job control

The shell (`bin/sh`) builds pipelines with `io.pipe()`, spawns every stage in
one process group (`pgid`) with the right `fds` mapping, and the terminal's pty
signals that group (`^C` → `SIGINT`, `^Z` → `SIGTSTP`). Your program gets all of
that for free as long as it reads fd 0, writes fd 1/2, and exits on
`SIGINT`/`SIGTERM` (the default action; only register handlers if you must
clean up).

The shell language (parsed in `bin/sh/syntax.ts`, run in `bin/sh/main.ts`):
pipes `|`, redirects `> >> < 2>`, `&&` `||` `;` `&`, quoting, globbing,
`$VAR`, arithmetic, `if/for/while`, functions, job control (`jobs fg bg`).
`man sh` has the full text.

## Interpreted programs: scripts

You don't have to add TypeScript to the repo to add a command. Any readable
file whose first line is a shebang runs:

```sh
#!/ProgramFiles/sh
echo "hello from $USER"
```

```js
#!/ProgramFiles/node
export async function main(os, args) { /* CLI JS program, same os API */ }
```

See [User apps](09-user-apps.md).

## Documenting it: man pages

Add `src/bin/man/pages/<name>.txt` (plain text). `man` globs
`pages/*.txt` at build time, so `man <name>` works with no registration. Match
the style of existing pages (name, usage, flags, a couple of examples).

## Privilege: setuid and admin programs

`setuid` is a flag in `binfmt.ts` (`SETUID` set in code: `su`, `sudo`, `passwd`).
The program runs with euid 0 and the caller's real uid. Be paranoid: such a
program is the kernel's trust boundary for identity changes. Don't add to the
set without a security review; prefer asking the user to `sudo` it.

## Checklist

- [ ] `src/bin/<name>/main.ts` exports `main(os, args)` and always calls `exit`
- [ ] Errors go to fd 2 as `name: arg: CODE`, non-zero exit
- [ ] Reads stdin when given no file arguments
- [ ] Pure logic in `lib/`, covered by a `*.check.ts` that is listed in `package.json` → `check`
- [ ] `src/bin/man/pages/<name>.txt`
