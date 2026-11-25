# 6. Security model

The design goal: **untrusted code (any app, any user-written script) can do
exactly what the kernel's syscalls allow, and nothing else.** The browser
provides the walls; the kernel provides the doors.

## The walls: realms

Every non-in-page process lives in a realm built by
[`kernel/proc/realm.ts`](../src/kernel/proc/realm.ts):

- **`<iframe sandbox="allow-scripts">` without `allow-same-origin`** → an
  *opaque origin*. No access to the kernel's DOM, cookies, `localStorage`,
  IndexedDB or **OPFS** (where `/home` lives). Workers get the same by being
  created inside such a frame (the worker host), so they inherit the opaque
  origin and the CSP rather than sharing the kernel's origin, which would let
  them open OPFS directly and bypass the VFS.
- **A CSP** injected into each realm host page by the `realm-csp` Vite plugin
  ([`vite.config.ts`](../vite.config.ts)):

  ```
  default-src 'none';
  script-src 'self' [blob: on user-* hosts];
  worker-src  'none' (app frames) | data: (worker hosts);
  connect-src 'none'          (dev: 'self' ws: wss: for HMR);
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;  font-src 'self' data:;  media-src 'self' data: blob:;
  object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'
  ```

  Consequences app authors hit constantly: **no `fetch`/XHR/WebSocket, no
  external images or fonts, no iframes, no forms that submit.** Images must be
  `data:`/`blob:`/same-origin; favicons for external sites can't be loaded
  (generate identities locally).
- **Navigation watch**: a sandboxed frame can navigate *itself* (e.g. to
  smuggle data in a URL) and CSP can't stop that. The kernel counts `load`
  events; a second one faults the process.
- **Kill = removal**: removing the iframe unloads the realm and closes its port.

## The doors: the wire and the syscall table

- A realm has exactly one channel: its `MessagePort` (boot message delivered
  only if `event.source === window.parent`, version-checked, accepted once).
- The kernel **binds the pid** to the port at creation. A message can never
  name a different caller.
- Message names must be own keys of `WIRE_CALLS` (no `__proto__` tricks);
  messages are parsed and rejected if malformed; callbacks are opaque ids.
- Compile-time alignment of `WIRE_CALLS` ↔ `AppInterface` ↔ `SyscallTable`.
- Errors cross as `{ code, message, details }`.

## Who is asking: process identity

| Property | Meaning | Set by |
| -------- | ------- | ------ |
| `uid`, `euid`, `gid` | real/effective user and one group; `euid 0` is root | inherited; `setuid` programs; `su`/`sudo` |
| `privileged` | may use system powers (display root, struts, hotkeys, `setPolicy`, `bindSession`, see all events) | **binfmt only**, for `/System/*` |
| `untrusted` | code read from the VFS, or a descendant of it | `host: "user"` programs; inherited by every child |
| `admin` (file flag) | exec requires admin group | `admin: true` in the app manifest |

`untrusted` is deliberately inherited: if a user script spawns `sudo` or `su`,
the result is still untrusted. It is checked *before* every euid-0 shortcut
that guards the owner's data.

### What each gate checks

| Capability | Gate |
| ---------- | ---- |
| File access | Unix bits via `Cred` (see [filesystem](04-filesystem.md#permissions)) |
| `/mnt/cloud` | trusted **and** real uid == the signed-in session user |
| `os.api.fetch` | trusted **and** (privileged, or real uid == session user); path must be same-origin `/api/...` |
| `os.net.fetch` | euid 0 or admin group; `https:` only; the backend requires the owner session and rejects private addresses (SSRF guard in `server/net.ts`) |
| `os.shell.openExternal` | `https:` / `mailto:` only; the browser needs a user click; opened `noopener,noreferrer` |
| `os.clipboard.readText` | needs recent user activation |
| `os.shell.download` | reads the file with the caller's permissions; always `application/octet-stream` |
| `os.windows.*` on another process's window | owner, privileged, euid 0, or same user |
| `os.process.kill/wait` another process | same user, or parent, privileged, euid 0 |
| `spawn` as another uid | parent euid 0 only |
| Admin-only app | the exec bit on a `0750`/gid-10 program file |
| Display internals | `privileged` |

Never reveal the existence of the owner account through app behaviour. The
Calendar, for example, reports a refused calendar sync as an ordinary "Couldn't
reach that calendar." and must not hide or disable UI by inspecting
`os.process.ids()`. Authorisation is *attempted and refused*, never
pre-checked and shown.

## The backend as the real gate

The browser-side checks keep honest code honest. The **server** is what protects
the owner's data: every `/api/private/*` request requires a signed session
cookie, state-changing requests are CSRF-checked, bodies are size-limited, login
is rate-limited and uses a password hash plus TOTP (`server/auth.ts`,
`server/totp.ts`, `server/main.ts`). Client-side `mayReachBackend` and the VFS
`mountFor` exist so a *visitor's program running inside the owner's tab* can't
borrow the owner's cookie.

## Web (external-site) apps

A manifest with a `url` frames an external site with
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"`
and no port: it has *its* origin's storage, never the kernel's, and makes no
syscalls.

## Rules for building apps safely

1. **Never `innerHTML` text you didn't write** (file contents, calendar feed
   fields, user input). Use `textContent`, `h()`, or build nodes. `html()` /
   `?raw` templates are for *your own markup only*.
2. Treat `os.shell.location()` (the URL) and anything from files as untrusted
   input. Validate: the launcher accepts only known app ids from `?launch=`,
   never paths.
3. Manifests from user files (`//@app`) are validated and size-capped;
   everything an app declares is shown as plain text by Spotlight. Do the same
   for any data you parse from files someone else may have written.
4. Don't weaken the CSP or the sandbox flags "for convenience". The product
   principle is that security boundaries are never loosened.
5. Use the narrowest power: write config under `~/.config`, not `/etc`; don't
   ask for `admin` unless the app handles the owner's private data.
6. If a feature needs the network, it goes through `os.net.fetch` (owner only)
   or an explicit `/api/private/...` route on the backend, never a new hole in
   the CSP.
