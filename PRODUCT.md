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
- **Shortcuts app** (added 2026-10): each user's own list of website shortcuts, stored in their `~/.config`. Clicking opens the site in a new browser tab. Primary use is a quick launcher: 5–20 sites opened daily, so speed and recognisability matter more than organisation.
- Site favicons cannot be loaded (CSP); site identity must be generated locally.
- **Calendar app** (added 2026-10): subscribed calendars only — an https `.ics` link, or an `.ics` file imported from the VFS. It never creates events. Each feed's raw body is cached in `~/.config/calendar/` so the month, week and agenda views draw instantly and offline; the `upnext` menu bar extra shows the next event from the same cache.
  - The subscription list is the person's, so it is kept on the server at `/mnt/cloud/calendar/subscriptions.json` and every browser signed in as the owner shows the same calendars; a browser picks up another's edits on its next minute tick. Sync bookkeeping (last sync, failures, body size) stays in `~/.config/calendar.json`, which is also what `upnext` reads and what the app falls back to whenever the mount refuses — which, as in Files, is what everyone who is not the owner meets. The sidebar names the storage either way, and nothing branches on who is running the app.
  - Syncing a link runs through `os.net.fetch`, which the kernel gates on the admin group and the backend gates on an owner session. The UI reports that refusal as an ordinary "Couldn't reach that calendar." and must never reveal that an owner account exists: no code may branch on `os.process.ids()` to hide or disable the link field, and every failed link offers the same `.ics` import as a way through. Importing a file works for every user.
  - Recurring events support a deliberate subset of RFC 5545 (`FREQ` daily/weekly/monthly/yearly, `INTERVAL`, `BYDAY` with ordinals, `BYMONTH`, `BYMONTHDAY`, `COUNT`, `UNTIL`, `WKST`, `EXDATE`, `RDATE`, `RECURRENCE-ID`). `BYSETPOS` and friends are out, which is what keeps occurrence generation ascending and the windowed walk correct.

## Brand Commitments
- The OS's existing dark app theme (`src/ui/theme.css`) and user-chosen accent color are shared by every app.

## Evidence on Hand
- Resume content: `src/apps/resume/content.ts`. Wallpapers and app icons in `public/assets/`.

## Product Principles
- Real software, not a demo: every app works fully, persists its state, and handles errors.
- Every app speaks the same visual and interaction language as the rest of the OS.
- Respect the sandbox: security boundaries stay intact and are never loosened for convenience.
