# 11. Extending the kernel

How to add the things apps build on. Each recipe lists every file you have to
touch; the type system catches most omissions (that's by design).

## Add a syscall

Say you want `os.clipboard.clear()`. Five places:

1. **Implement it** in the area's file under
   [`kernel/syscalls/`](../src/kernel/syscalls/) (or a new file for a new area).
   Wrap it in a guard so a dead process can't call it:

   ```ts
   // syscalls/clipboard.ts
   clipboardClear: alive(ctx, async (_pid: Pid) => { buffer = { text: "", synced: false }; }),
   ```

   Guards in [`syscalls/guards.ts`](../src/kernel/syscalls/guards.ts):
   - `alive(ctx, fn)`: process must exist and not be exiting/zombie.
   - `privileged(ctx, fn)` / `requirePrivilege(ctx, pid, name)`: system programs only.
   - `requireControl(ctx, caller, target)`: parent, privileged or euid 0.
   - `rejectOnThrow(fn)`: turn a synchronous throw into a rejection.

   For anything touching files, **pass the calling process as the credential**
   (`ctx.fs.readFile(path, signal, proc)`); the VFS defaults to ROOT.

2. **Add it to `SyscallTable`** and the spread in `createSyscallTable` in
   [`syscalls/table.ts`](../src/kernel/syscalls/table.ts) (new files:
   `...myAreaSyscalls(ctx)`). Every call gets `callerPid` first. `table.ts`
   also wraps everything in `gateStopped`, so a stopped process's new calls park
   until `SIGCONT` automatically.

3. **Add it to the public interface**: `AppInterface` in
   [`syscalls/api.ts`](../src/kernel/syscalls/api.ts) (and `SystemInterface` if
   it's privileged or in-page only), then implement the binding in
   `bindSyscalls`.

4. **Put it on the wire**: add `"clipboard.clear": "clipboardClear"` to
   `WIRE_CALLS` in
   [`wire/protocol.ts`](../src/kernel/wire/protocol.ts). Use `null` to declare
   "exists on the interface but is in-page only" (the server answers `ENOSYS`).
   The compile-time `WireCallsAligned` assertion fails if the name, arity or
   argument types don't line up with `SyscallTable`.

5. **Add the realm-side call** in
   [`runtime/os.ts`](../src/runtime/os.ts) `buildAppInterface`:
   `clear: () => call("clipboard.clear")`. Members that are purely local (e.g.
   `process.pid`, timers, `readTextFile`) are listed in `RuntimeLocal` in
   `protocol.ts` and implemented in `os.ts` directly.

Then update [the syscall reference](03-syscalls.md).

**Wire constraints**

- Arguments and results must be **structured-cloneable** (no DOM nodes, no
  class instances with methods, no functions except as callbacks).
- A function argument becomes a callback ref. If a call registers *one*
  long-lived callback (subscribe, onSignal), use `client.callWithDisposer` so
  the realm gets a disposer that sends `release`, and register a **resource**
  on the process so the kernel drops it on exit.
- `windows.create` is the one call whose wire result (`WindowId`) differs from
  its interface result (a handle built realm-side).
- Validate everything. The realm is hostile: check types, lengths, enums
  (see `syscalls/status.ts` `validate`, `hotkeys.ts` `isHotkey`).

**Security checklist for a new syscall**

- [ ] Who may call it? (any process / same user / privileged / root / owner session)
- [ ] If it touches files, is the credential passed so `untrusted` and cloud rules apply?
- [ ] Does it let a process affect another process or window? Use `requireControl` / `mayArrange`.
- [ ] Does it reach outside the sandbox (network, clipboard, downloads, navigation)? Gate it on user activation, an allow-list of schemes, or the admin group.
- [ ] Is everything bounded (sizes, counts, per-process limits)?
- [ ] Does the failure not reveal anything the caller shouldn't know (file names, whether the owner exists)?

## Add an event

1. Add a member to the `KernelEvent` union in
   [`events/types.ts`](../src/kernel/events/types.ts).
2. Emit it with `ctx.events.emit({ type: "...", ... })` from where it happens.
3. Decide delivery in
   [`proc/subscribe.ts`](../src/kernel/proc/subscribe.ts). Events carrying a
   `pid` are only delivered to that process (unless the subscriber is
   privileged); events about paths should be filtered by what the subscriber could
   list. Add a case if yours needs a new rule.
4. Document it in [the syscall reference](03-syscalls.md#osevents).

## Add a filesystem driver or mount

1. Implement `FileSystemDriver`
   ([`fs/fsdriver.ts`](../src/kernel/fs/fsdriver.ts)). Use opaque, branded
   `Node`s (see `MemFS`'s `BRAND`) and reject nodes that aren't yours.
   Implement `open?` if the node isn't a plain byte file.
2. Throw `KernelError`s with the standard codes (`ENOENT`, `EEXIST`, `ENOSPC`...).
   Throw `EXDEV` from `rename` when you can't move within the driver.
3. Mount it in [`core.ts`](../src/kernel/core.ts): `fs.mount({ path, driver, readonly, remote? })`.
4. If it's persistent and has no native owner/mode storage, include its path in
   `fs.attrsUnder([...])` so attributes are saved (currently `/home`, `/etc`).
5. If it's served by the backend, set `remote: true` so it inherits the cloud
   rules (untrusted refused, session-bound, fixed permissions); add the
   `ProcFS` type label in the `mounts` callback in `core.ts`.
6. Add a `*.check.ts` that tests *who is refused* using a `MemFS` in disguise
   (`fs/remote.check.ts` is the template), and register it in `package.json`.

## Add a system (in-page or privileged) program

Only for things that must draw into the kernel's own document (`display.root()`,
the taskbar layer) or must be privileged.

```ts
// binfmt.ts
"/System/Clock": { load: () => import("../System/Clock/main"), privileged: true },
```

- In-page programs get a full `SystemInterface` and can touch the DOM; keep
  them few: they are the trusted computing base.
- `privileged: true` is the *only* way to be privileged. It's decided here, in
  source, never by a file in the VFS.
- Start it from `/etc/autostart` (`AUTOSTART_DEFAULT` in `core.ts`), or have
  another system program spawn it. The seed upgrades an untouched older default
  automatically; add the previous default to `AUTOSTART_PREVIOUS`.
- A privileged iframe program (Spotlight, DebugPs) is a normal `format:
  "iframe"` entry plus `privileged: true`, and its module must be added to the
  glob in `runtime/iframe-entry.ts` (those are the only non-`apps/*/main.ts`
  files in it).

## Add a window-manager feature

Mechanics belong in
[`windows/manager.ts`](../src/kernel/windows/manager.ts); policy belongs in
user space. The pattern used for snapping: the kernel provides `windows.tile`,
drag-snap geometry (pure functions in `windows/snap.ts` with a
`snap.check.ts`), and a `setPolicy` switch that a privileged program (the
Taskbar) flips based on Settings. If you add a gesture, put the geometry in a
pure module and test it in Node.

## Add a hotkey

Realms forward only a fixed set of keys (`runtime/frame.ts`, validated again in
`realm.ts`), because keys pressed in an iframe never reach the kernel's
document. To add one: extend `Hotkey` / `HOTKEYS` / `hotkeyFor` in
[`syscalls/hotkeys.ts`](../src/kernel/syscalls/hotkeys.ts), and have a privileged
process `claimHotkey` it. Remember it takes the key away from every app.

## Add a backend route

[`server/main.ts`](../server/main.ts). Private routes go under
`/api/private/` and begin with `requireSession(req)`; POSTs are CSRF-checked
against `PUBLIC_ORIGIN`; bodies are size-limited (the upload route is the one
that takes raw bytes). Never log request bodies. Expose it to the OS through a
mount or `os.api.fetch` (trusted + owner only), not through anything an
untrusted realm can reach. `node server/selftest.ts` checks the auth
primitives; `pnpm dev:api` runs it locally with `.env`.

## Conventions in kernel code

- Comments explain *why* and name the threat or invariant; keep that style.
- `ponytail:` comments mark deliberate simplifications and what to do if they
  bite (no umask, regex import rewrite, one group per process). Add one rather
  than silently cutting a corner.
- Prefer pure modules for logic (no `os`, no DOM) with a sibling `*.check.ts`
  that runs in Node. Self-checks inside a file can use
  `if (import.meta.main) { ... }` (see `fs/perm.ts`).
- Kernel code must not depend on `src/apps/*` (except `registry.ts` data used by
  the launcher/desktop); apps must not import kernel internals beyond types and
  the shared `utils/`.
- Syscalls never trust the caller's arguments and never accept a pid from the
  realm.
