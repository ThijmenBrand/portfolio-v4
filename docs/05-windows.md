# 5. Windows and display

The window manager
([`kernel/windows/manager.ts`](../src/kernel/windows/manager.ts)) lives in the
kernel's document. It draws the frames (title bar, buttons, resize edges) and
owns focus, stacking, snapping and minimising. An app never receives a
reference to a frame; it gets a *handle* (an id plus a few methods).

## Two kinds of surface

| Surface | What it is | Created by |
| ------- | ---------- | ---------- |
| `window` (default) | framed, draggable, resizable, appears in the taskbar, can snap/maximise/minimise | `app.ts` `window` options |
| `overlay` | no frame; floats above every window and the taskbar, centred near the top; **hidden until its app shows it**; not a window to the shell (no taskbar button, no `window.*` events, no snapping, no cycling) | binfmt entry with `window.surface: "overlay"`; only Spotlight uses it |

The surface kind is fixed at exec time.

## How an iframe app gets its window

```
spawn("/ProgramFiles/todo")
  └─ executeIframe():
       1. kernel creates the window (from binfmt's `window` options)   ← before the app exists
       2. kernel creates <iframe sandbox="allow-scripts"> inside it, for good
          (moving an iframe in the DOM would reload it)
       3. realm boots, runs main(os, args)
       4. app calls os.windows.create({ title }) → this CLAIMS that window (one per process)
```

So `windows.create` in a realm is really "claim". The options you pass then
refine the already-created window: `title`, `width`/`height` (resizes it),
`translucent`, `titleBar`. A second `create` is `EINVAL`.

The iframe is hidden (`is-loading`) until its host page has painted, so launching
never flashes a white frame. Clicks inside the iframe don't reach the kernel's
DOM, so the realm's host page reports `realm-pointerdown` to the kernel to
raise the window; it likewise forwards the system keys (see below).

## `WindowOptions` in `app.ts`

```ts
window: {
  title: "Todo",
  width: 520, height: 620,          // initial size
  minWidth: 340, minHeight: 360,    // optional constraints (maxWidth/maxHeight too)
  translucent: true,                // frosted glass: make your html/body background transparent
  titleBar: "hidden",               // content runs under the bar; the top 34px stays a drag strip
}
```

## Closing

- Closing a window (X button, Ctrl/Cmd+W, `os.windows.close`) calls
  `requestClose`.
- **No handler registered**: default close. For an iframe app this ends the
  process (the realm lives inside the window, so there is nothing left to run).
- **Handler(s) registered** with `handle.onCloseRequest(cb)`: the kernel calls
  them instead and does *not* close. This is how an app asks "save changes?".
  If the user insists (a second close request within a short window) the
  kernel force-closes with SIGKILL semantics (exit 137), so a buggy handler
  can't make a window unclosable.

The convention for simple apps is:

```ts
const handle = await os.windows.create({ title: "Notes" });
void handle.onCloseRequest(() => void os.process.exit(0));
```

## Windows, snapping and policy

Dragging to a screen edge snaps (half, quarter, or maximise); `Ctrl+Alt+Arrow`
and the layouts picker do the same, and `os.windows.tile(id, target)` is the
syscall (used by the `wm` command). Tiles share inner edges, so resizing one
moves its neighbours. Snapping *mechanics* are the kernel's; the *policy*
(on/off, snap assist) is user-space: the Taskbar reads Settings and calls the
privileged `windows.setPolicy({ snap })`. On phones (`PHONE_QUERY` in
[`utils/phone.ts`](../src/utils/phone.ts)) every window opens maximised and
there is no dragging, resizing or snapping.

Who may arrange a window (focus/tile/list): its owner, a privileged process,
euid 0, or any process of the *same user* (which is how `wm` in a terminal can
arrange your apps).

## Listing windows

```ts
const windows = await os.windows.list();      // WindowInfo[]
// { windowId, pid, title, minimized, state: "normal"|"maximized"|"tiled",
//   tile?, frame: Rect, restoreFrame?, focused }
```

Subscribe to `window.created`, `window.destroyed`, `window.focused`,
`window.titleChanged`, `window.minimized`, `window.stateChanged` to follow
changes (a non-privileged process only hears about *its own* windows).

## The work area and struts

`os.display.workArea()` is the screen minus reserved edges. The Taskbar
reserves its space with `reserveStrut(edge, size)` (privileged). When it changes
the kernel reflows tiled windows and emits `display.workAreaChanged`.

## Status items (top-bar extras)

Any app can put a small icon, optional label and menu in the top bar:

```ts
const id = await os.display.addStatusItem(
  { icon: "<svg viewBox='0 0 16 16'>…</svg>", title: "Timer", label: "4:59",
    menu: [{ id: "5", label: "5 minutes" }, { separator: true }, { id: "quit", label: "Quit" }] },
  (menuId) => { /* user chose a menu item */ },
);
await os.display.updateStatusItem(id, { label: "4:58" });
```

Limits: 5 per process; icon must be inline SVG ≤ 8 KB; strings are
length-limited and validated by the kernel. They disappear when the process
exits. `bin/timer`, the `upnext` extra and Snake's score are examples. The
SVG is rendered by the kernel, so write it self-contained (no external refs).

## System hotkeys

Keys pressed in an app's iframe never reach the kernel's document, so every
realm host page forwards a small fixed set (`runtime/frame.ts`):

| Keys | Effect |
| ---- | ------ |
| Cmd+K (Ctrl+K off a Mac) | the `palette` hotkey → Spotlight (claimed by a privileged process with `display.claimHotkey`) |
| Ctrl/Cmd+Space | the launcher |
| Ctrl+W | request close of the focused window |
| Ctrl/Cmd+\` | cycle windows |
| Ctrl+Alt+Arrow | snap the focused window |

Because only these are forwarded, do not use them for your own shortcuts. The
names in a forwarded message are validated against allow-lists in the kernel
(a hostile realm can't invent hotkeys).

## Overlays (how Spotlight works)

An overlay process: is privileged (it claims the hotkey), runs forever,
stays hidden, and when its hotkey fires it calls
`os.windows.setVisible(id, true)` and sizes itself with
`os.windows.setSize(id, { height })`. A click anywhere else, Escape, or another
window gaining focus hides it again; Ctrl+W over an overlay hides rather than
closes it.

## The file dialog

`os.dialog.open({ kind: "file" | "directory" | "save", ... })` draws a modal
sheet over the caller's window ([`kernel/dialog/`](../src/kernel/dialog/)). See
[syscalls](03-syscalls.md#osdialog).
