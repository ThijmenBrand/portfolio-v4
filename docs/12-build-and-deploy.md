# 12. Build, check and deploy

## Prerequisites

Node 24, pnpm 11 (`packageManager` in `package.json`). Install with
`pnpm install`.

## Scripts

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | Vite dev server (`:5173`). `/api` is proxied to `localhost:8787`. Hot reload for the kernel and for apps (each realm host loads from the same dev server). |
| `pnpm dev:api` | the Node API (`server/main.ts`) with `--watch --env-file=.env`; copy `.env.example` to `.env` first. Needed for login and `/mnt/cloud`; the OS runs without it (the cloud mount just refuses). |
| `pnpm build` | `tsc` (strict typecheck of `src/`, including the wire alignment) **then** `tsc -p server` **then** `vite build`. This is also what CI runs. |
| `pnpm check` | every self-check (below). |
| `pnpm preview` | serve the production build. |

## Entry pages

[`vite.config.ts`](../vite.config.ts) builds five HTML entries:

| Page | Purpose |
| ---- | ------- |
| `index.html` | the kernel's page (`#screen`, `src/main.ts`) |
| `app-host.html` | boot page for **system** iframe apps (`runtime/iframe-entry.ts`) |
| `user-app-host.html` | boot page for **user** GUI programs (`runtime/user-entry.ts`), CSP adds `blob:` |
| `worker-host.html` | invisible frame that starts a **system** worker (`runtime/worker-host.ts`) |
| `user-worker-host.html` | same for **user** CLI programs |

The `realm-csp` plugin injects the Content-Security-Policy as a `<meta>` into
the four host pages (so it ships on any static host). Worker hosts list the
site origin explicitly in `script-src`/`worker-src` because Firefox resolves
`'self'` against the `data:` URL the worker is built from; in production
set `SITE_ORIGIN` at build time (e.g. `https://example.com`).

Sandboxed realms have an opaque origin, so their module fetches carry
`Origin: null`. Dev/preview allow that via the Vite `cors` option; **production
must send `Access-Control-Allow-Origin` on `/assets/*`** (the Caddyfile does).

## Checks

There's no test framework: each check is a plain Node script that throws on the
first failure. They run TypeScript directly via Node's type stripping;
`scripts/ts-resolve.js` is a resolve hook that adds `.ts` to extensionless
imports for checks that import kernel files.

```sh
node src/bin/lib/tools.check.ts                                    # plain
node --import ./scripts/ts-resolve.js src/kernel/fs/remote.check.ts  # kernel files
node scripts/todo-dom.check.js                                     # markup ↔ code
```

What's covered today (all wired into `pnpm check`):

| Check | Covers |
| ----- | ------ |
| `server/selftest.ts` | password hashing, sessions, login rate limit, SimpleLogin allow-list, TOTP, private-address (SSRF) guard, cloud path rules and cloud store |
| `kernel/fs/remote.check.ts` | who may use a remote mount |
| `kernel/windows/snap.check.ts` | snap geometry |
| `bin/sh/syntax.check.ts` | shell parser |
| `bin/lib/tools.check.ts`, `dev.check.ts` | diff/sed/tar engines, dev tools |
| `bin/session/model.check.ts` | the session model |
| `System/Spotlight/*.check.ts`, `utils/commands.check.ts` | search ranking, files, command validation |
| `apps/calendar/*.check.ts`, `scripts/calendar-dom.check.js` | ICS, layout, store, "mine" calendars, markup |
| `apps/todo/store.check.ts`, `scripts/todo-dom.check.js` | todo store/parsing, markup |
| `apps/projects/projects.check.ts`, `scripts/projects-dom.check.js` | project matching, markup |
| `apps/shortcuts/schedule.check.ts` | area schedule logic |

**The `*-dom.check.js` pattern:** apps read elements by `data-field` /
`data-action` with a non-null assertion, so a name with no element in the HTML
typechecks and then throws at first use. The DOM check scrapes the HTML and the
`main.ts` and fails on any mismatch. Do the same for any app with a big
template.

**Adding a check:** create `<thing>.check.ts` next to the code, use a few
`eq(actual, expected, what)` helpers (see any existing one), and **append it to
the `check` script in `package.json`**. Checks are not auto-discovered.

What to test: parsers, date math, layout geometry, store merge logic,
permission decisions, validators, anything pure. What not to: DOM rendering and
window behaviour; verify those by running the app.

## Running the app headlessly

There's no browser-test setup in the repo. Apps are sandboxed iframes inside
the kernel's page, so an automated driver (Playwright and similar) has to
reach into those frames, not just the top document. A browser tab at
`http://localhost:5173/?launch=<id>` boots straight into an app.

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`:

1. **check**: `pnpm install --frozen-lockfile && pnpm build`.
2. **build**: Docker image (Vite build, Caddy serving `dist/`, the Node API in
   the same image), pushed to `ghcr.io/thijmenbrand/portfolio-v4`, referenced by
   digest.
3. **deploy**: SSH to the server with a key whose forced command only accepts
   `deploy <image@digest>`, `rollback` or `status`. The script starts the new
   image, waits for its healthcheck, keeps the last good one and rolls back
   automatically on failure.

Runtime layout: one image, two services (`deploy/docker-compose.yml`): `web`
(Caddy) and `api` (`node /app/server/main.ts`, type-stripped `.ts` sources,
one dependency: `otpauth`). Caddy serves the static OS with a CSP, CORS on
`/assets/`, caching, and proxies `/api/*` to `api`.

Everything about server setup, secrets (`api.env`), the cloud volume and
rollback is in [`deploy/README.md`](../deploy/README.md). Server-side files
(`docker-compose.yml`, `portfolio-deploy`) are installed by hand and the
deploy refuses to run on drift; see that README.

## Environment variables (API)

From `.env.example`: `OWNER_USERNAME`, `OWNER_PASSWORD_HASH` (scrypt;
`node server/hash.ts`), `SESSION_SECRET` (≥ 32 chars), `OWNER_TOTP_SECRET`
(`node server/totp.ts <user>`), `PUBLIC_ORIGIN` (the CSRF origin check),
`NODE_ENV`, `CLOUD_DB` (SQLite file for the cloud tree), `CLOUD_DOCS`
(directory of file bytes), `SIMPLELOGIN_API_KEY` (Aliases app), optional
`CLOUD_QUOTA_MB` (default 1024).

## Releasing a change to an app: the loop

1. `pnpm dev`, build the feature, run it.
2. Add/extend `*.check.ts` for the pure logic; add it to the `check` script.
3. `pnpm check && pnpm build`.
4. Update `PRODUCT.md` (user-visible behaviour) and, if you changed the kernel
   surface, these docs.
5. Push to `main`; CI deploys.
