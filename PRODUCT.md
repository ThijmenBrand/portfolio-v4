# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- Visitors to Thijmen Brand's portfolio: they land in a small browser-based operating system, start on the Resume app, and explore the other apps (Files, Terminal, Code, Settings).
- The owner (admin group) and other logged-in users (including guest), each with their own home folder and `~/.config`.

## Product Purpose
A portfolio presented as a working operating system built from scratch (kernel, processes, VFS, window manager, sandboxed apps). The OS itself is the proof of skill; the apps must feel like real, trustworthy desktop software.

## Positioning
The portfolio is a functioning OS, not a mock-up: apps are real sandboxed processes using real syscalls, files and permissions.

## Operating Context
- Desktop and phone widths; apps run in resizable windows (or full-screen on phones).
- Apps run in `sandbox="allow-scripts"` iframes with a strict CSP (`img-src 'self' data: blob:`); no external images, no popups. External links go through the kernel's `os.shell.openExternal` (https and mailto only), which opens a new browser tab. The clipboard goes through the kernel too (`os.clipboard`), so copy/paste works between apps.
- Per-user configuration lives in `~/.config/*` and is edited by apps; Settings broadcasts SIGHUP so apps re-read accent changes.

## Capabilities and Constraints
- **Window snapping** (added 2026-10): dragging a window to a screen edge snaps it — left/right half, a corner for a quarter, the top to maximize (fullscreen); a preview shows where it lands, and dragging it away restores its floating size. Also by Ctrl+Alt+Arrow, the layouts picker on the maximize button, and `wm` in the terminal (`windows.tile`). Tiles share their inner edges: resizing one moves its neighbours. The mechanics are the kernel's window manager (the drag never leaves the kernel's document); the Taskbar sets the policy from Settings (`windows.setPolicy`) and draws Snap assist, which offers the other windows for the half left empty. Not on phones, where every window is fullscreen.
- **Shortcuts app** (added 2026-10): each user's own list of website shortcuts, stored in their `~/.config`. Clicking opens the site in a new browser tab. Primary use is a quick launcher: 5–20 sites opened daily, so speed and recognisability matter more than organisation.
- Site favicons cannot be loaded (CSP); site identity must be generated locally.
- **Calendar app** (added 2026-10): your own calendars, which you write in, beside subscribed ones — an https `.ics` link, or an `.ics` file imported from the VFS — which stay read-only. Each feed's raw body is cached in `~/.config/calendar/` so the month, week and agenda views draw instantly and offline; the `upnext` menu bar extra shows the next event from the same cache and from your own calendars.
  - Your own calendars (added 2026-10) are one `.ics` file each, in `/mnt/cloud/calendar/mine/` when the mount will have us and `~/.config/calendar/mine/` otherwise — decided by trying the mount, never by asking who is running the app. The folder is the list: each file carries its own name, colour and visibility, so it opens and imports anywhere as it is. An empty cloud folder is seeded from the browser's own on first sign-in. Every change is a read-modify-write of the latest file, so two browsers editing one calendar don't undo each other.
  - Events are made with the toolbar's New event (N), by double-clicking a day or an hour slot, or by dragging down the hour grid; clicking one opens it to edit or delete (with Undo). Fields: title, all-day, start and end, a simple repeat (daily/weekly/monthly/yearly, every N, optional last day), location, an https link and notes. Times are saved in the device's IANA zone. Editing a repeating event changes the whole series, moved by as much as the opened occurrence was. A subscribed event can be copied into a calendar of yours (that one occurrence) and edited there. The first event made with no calendar of your own creates one called "Calendar".
  - The subscription list is the person's, so it is kept on the server at `/mnt/cloud/calendar/subscriptions.json` and every browser signed in as the owner shows the same calendars; a browser picks up another's edits on its next minute tick. Sync bookkeeping (last sync, failures, body size) stays in `~/.config/calendar.json`, which is also what `upnext` reads and what the app falls back to whenever the mount refuses — which, as in Files, is what everyone who is not the owner meets. The sidebar names the storage either way, and nothing branches on who is running the app.
  - Syncing a link runs through `os.net.fetch`, which the kernel gates on the admin group and the backend gates on an owner session. The UI reports that refusal as an ordinary "Couldn't reach that calendar." and must never reveal that an owner account exists: no code may branch on `os.process.ids()` to hide or disable the link field, and every failed link offers the same `.ics` import as a way through. Importing a file works for every user.
  - Recurring events support a deliberate subset of RFC 5545 (`FREQ` daily/weekly/monthly/yearly, `INTERVAL`, `BYDAY` with ordinals, `BYMONTH`, `BYMONTHDAY`, `COUNT`, `UNTIL`, `WKST`, `EXDATE`, `RDATE`, `RECURRENCE-ID`). `BYSETPOS` and friends are out, which is what keeps occurrence generation ascending and the windowed walk correct.
- **Todo app** (added 2026-10): a person's todos. Each has two optional, separate "when"s: the plan (a day you mean to do it, optionally a time and a length) and the deadline (a day it is due, optionally a time). They are kept apart because they behave differently: a plan slips, and a missed one simply carries over to today; a deadline doesn't, and passing it is the only thing drawn as late (red). Deadlines are grey while there's time and amber within three days. The list is grouped by plan, with anything past its deadline on top and deadlines with no plan under "Needs a plan"; a plan that ends after its deadline is flagged, with a one-click fix. Finishing one is meant to feel rewarding: a synthesised two-note chime (Web Audio, nothing loaded, mutable from the app) and a tick that pops, draws in and throws a few sparks before the row folds away into Completed.
  - Stored like the calendar list: `/mnt/cloud/todo/todos.json` when the mount will have us, `~/.config/todo.json` otherwise, decided by trying the mount and never by asking who is running the app.
  - The Calendar draws every planned todo — timed ones at their time of day in the hour grid, for their length, outlined in the accent colour so they stand out from meetings; untimed ones as all-day items; a missed plan dashed where it was and again on today — and they can be ticked off there. Open todos' deadlines are flags: a line across the day at a timed deadline, an all-day chip otherwise, hideable on their own. Hovering any of a todo's items lights up the rest. Both apps write the one file, so every change is a read-modify-write of the latest copy, and each follows the other's writes through `fs.changed`.
- **Projects app** (added 2026-10): one place per course or project for everything about it. Three columns: areas (Uni, Work, Private, each with times it opens on its own, like Shortcuts' spaces) with Today and Upcoming above them; the courses and projects in the area; and the page. On a phone, or in a window that narrow, the columns become a drill-down.
  - Owner only (`admin: true` in its manifest, like Fintrack): other users don't see it in the app menu or Settings, and the kernel refuses to exec it for them. The Calendar and Todo app still work for them; they just have no projects to file or colour todos by.
  - A project's page is one scrolling page: its shortcuts (keys 1–9 open them), its goals, its other todos and its notes, beside the coming week to plan in. A goal is a larger piece of work with a deadline (an assignment); its parts are todos, each planned on a day of its own. A goal's page lays out the days up to the deadline to drag parts onto, and flags a part planned after the deadline with a one-click fix. A new goal is written in a card shaped like the goal it becomes: its name, then a deadline from a few likely days (a week or two out, a course's next session of each kind, due at its start) or from a small month that dots the course's sessions. The deadline is never a native date field, which can't be opened from the sandbox.
  - Goals and parts are ordinary todos in the Todo app's file, carrying `project`, `goal` and `parent`, so the Todo app and the Calendar show them; the Calendar draws a filed todo in its project's colour. A todo added in this app must be filed: on Today and Upcoming, # picks the project (or goal).
  - Areas and projects are kept like the todo list: `/mnt/cloud/projects/projects.json` when the mount will have us, `~/.config/projects.json` otherwise. Notes are markdown files in a folder per project (`/mnt/cloud/projects/<folder>/` or `~/Projects/<folder>/`), so they open in Code and Files too; the folder is the list.
  - A course finds its sessions in your calendars, read-only from what the Calendar has cached: an event belongs to it when its code or name appears in the title or notes as a whole word ("SOS" finds "SOS VO", never "SOSE VO"), and the word after the code is the session type (VO, UE…, renamable). Its page shows the next session and the weekly slots; it can open on its own during a session, count sessions as busy, and move to Ended after the last one. Planning views show calendar events as busy time and the free gaps of an hour or more between 8:00 and 20:00.
  - On first use it offers to bring in the Shortcuts app's spaces as areas and projects; Shortcuts keeps its own copy.

## Brand Commitments
- The OS's existing dark app theme (`src/ui/theme.css`) and user-chosen accent color are shared by every app.

## Evidence on Hand
- Resume content: `src/apps/resume/content.ts`. Wallpapers and app icons in `public/assets/`.

## Product Principles
- Real software, not a demo: every app works fully, persists its state, and handles errors.
- Every app speaks the same visual and interaction language as the rest of the OS.
- Respect the sandbox: security boundaries stay intact and are never loosened for convenience.
