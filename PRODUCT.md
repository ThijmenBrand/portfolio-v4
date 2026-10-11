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
- Apps run in `sandbox="allow-scripts"` iframes with a strict CSP (`img-src 'self' data: blob:`); no external images, no popups. External links go through the kernel's `os.shell.openExternal` (https and mailto only), which opens a new browser tab.
- Per-user configuration lives in `~/.config/*` and is edited by apps; Settings broadcasts SIGHUP so apps re-read accent changes.

## Capabilities and Constraints
- **Shortcuts app** (added 2026-10): each user's own list of website shortcuts, stored in their `~/.config`. Clicking opens the site in a new browser tab. Primary use is a quick launcher: 5–20 sites opened daily, so speed and recognisability matter more than organisation.
- Site favicons cannot be loaded (CSP); site identity must be generated locally.

## Brand Commitments
- The OS's existing dark app theme (`src/ui/theme.css`) and user-chosen accent color are shared by every app.

## Evidence on Hand
- Resume content: `src/apps/resume/content.ts`. Wallpapers and app icons in `public/assets/`.

## Product Principles
- Real software, not a demo: every app works fully, persists its state, and handles errors.
- Every app speaks the same visual and interaction language as the rest of the OS.
- Respect the sandbox: security boundaries stay intact and are never loosened for convenience.
