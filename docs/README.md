# PortfolioOS documentation

PortfolioOS is a small operating system that runs in a browser tab: a kernel
(processes, a virtual filesystem, a window manager, signals, pipes, ptys,
users and permissions) with applications that run as sandboxed processes and
talk to it only through syscalls.

These docs explain how the kernel works and how to build programs for it.

| # | Page | Read it when you want to... |
| - | ---- | --------------------------- |
| 1 | [Architecture](01-architecture.md) | understand the whole picture: layers, boot, source layout |
| 2 | [Processes and executables](02-processes.md) | know how programs start, run, signal each other and die |
| 3 | [Syscall reference](03-syscalls.md) | look up every `os.*` call |
| 4 | [Filesystem](04-filesystem.md) | work with files, mounts, permissions, `/proc`, the cloud mount |
| 5 | [Windows and display](05-windows.md) | open windows, overlays, status items, hotkeys |
| 6 | [Security model](06-security.md) | understand the sandbox, and what each kind of process may do |
| 7 | [Building a built-in app](07-building-apps.md) | **add a GUI app to the OS (start here for apps)** |
| 8 | [Building a command-line program](08-cli-programs.md) | add a `/ProgramFiles/<name>` command |
| 9 | [User apps (apps built inside the OS)](09-user-apps.md) | write, bundle and install apps from within PortfolioOS |
| 10 | [App patterns and conventions](10-patterns.md) | storage, live updates, theming, Spotlight, phones |
| 11 | [Extending the kernel](11-extending-the-kernel.md) | add a syscall, event, filesystem driver or system program |
| 12 | [Build, check and deploy](12-build-and-deploy.md) | run, typecheck, test and ship |

## The idea in one paragraph

Everything an app can do goes through one object, `os`, whose methods are
syscalls. An app runs in an isolated browser realm (a sandboxed iframe or a
worker with an opaque origin and a CSP that forbids network access), so it has
no other way out: not the DOM of the OS, not `fetch`, not browser storage. The
kernel validates every call against the calling process's identity (uid, gid,
privileged or not, trusted or not) before doing anything.

```
 ┌──────────────── browser tab (the kernel's page) ────────────────┐
 │  kernel: VFS · processes · windows · events · syscall table     │
 │      ▲                    ▲                     ▲               │
 │      │ MessagePort        │ MessagePort         │ in-page call  │
 │  ┌───┴────────┐      ┌────┴───────┐       ┌─────┴───────────┐   │
 │  │ iframe app │      │ worker     │       │ system program  │   │
 │  │ (GUI)      │      │ (CLI)      │       │ (Taskbar,       │   │
 │  │ sandboxed  │      │ sandboxed  │       │  Desktop, Login)│   │
 │  └────────────┘      └────────────┘       └─────────────────┘   │
 └─────────────────────────────────────────────────────────────────┘
```

## Quick start: a new GUI app in four steps

1. Create `src/apps/notes/app.ts` (the manifest) and `src/apps/notes/main.ts`
   (the program), plus an icon in `public/assets/icons/notes.svg`.
2. There is no step two: the file `import.meta.glob`s in
   [`binfmt.ts`](../src/kernel/binfmt.ts) and
   [`registry.ts`](../src/apps/registry.ts) find it. It is now
   `/ProgramFiles/notes`, in the app menu, and launchable with `?launch=notes`.
3. `pnpm dev` and open it.
4. `pnpm build` to typecheck.

The full walkthrough is in [Building a built-in app](07-building-apps.md).

## Conventions used in these docs

- "Realm" means an isolated JS execution context a process lives in (an iframe
  or a worker). "In-page" means code running directly in the kernel's own
  document.
- Paths like `src/kernel/...` are relative to the repository root and link to
  the source. The source comments are detailed; when this documentation and
  the code disagree, the code wins, and the doc should be fixed.
- `os` is always an `AppInterface` (see [syscalls](03-syscalls.md)).
