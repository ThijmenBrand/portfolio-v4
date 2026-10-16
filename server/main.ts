// The portfolio's API: owner login + private routes. Node stdlib plus otpauth,
// run directly by Node (type stripping, no build step):
//   node server/main.ts            (dev: pnpm dev:api, behind Vite's /api proxy)
// In production only the container's Caddy reaches it (deploy/web/Caddyfile).
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  HttpError,
  OWNER_USERNAME,
  PUBLIC_ORIGIN,
  SESSION_MAX_AGE,
  rateKey,
  requireSession,
  signSession,
  verifyPassword,
  verifyTotp,
} from "./auth.ts";
import { requirePath } from "./fspath.ts";
import * as cloud from "./fsstore.ts";
import { netFetch } from "./net.ts";
import { callSimpleLogin, slRoute } from "./simplelogin.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SECURE = process.env.NODE_ENV === "production" ? "; Secure" : "";
const BODY_LIMIT = 64 * 1024;

// --- login rate limit ---------------------------------------------------------
// ponytail: in-memory, per process. Resets on restart and only works with a
// single instance; move it to a shared store (Redis, the DB) if that changes.
// Per client (IPv4 address or IPv6 /64), plus a ceiling for everyone together
// so rotating addresses doesn't buy unlimited guesses.
// ponytail: a global flood locks the owner out for the window too; that beats
// unlimited guessing.
const LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPTS_GLOBAL = 50;
const LOGIN_WINDOW = 15 * 60 * 1000;
// The cloud filesystem is session-gated, so this isn't a guessing limit: it
// stops one looping app from burning CPU and quota. Generous enough that
// ordinary use (a few requests per file operation) never notices.
const FS_REQUESTS = 600;
const FS_WINDOW = 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function allowed(key: string, limit: number, window: number, now = Date.now()): boolean {
  // Drop stale entries now and then so the map can't grow without bound.
  if (attempts.size > 10_000)
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  let entry = attempts.get(key);
  if (!entry || entry.resetAt <= now)
    attempts.set(key, (entry = { count: 0, resetAt: now + window }));
  return ++entry.count <= limit;
}

// Only Caddy can reach the API, and it sets X-Forwarded-For to the real client
// (first entry). The socket address is the fallback for dev without a proxy.
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

// --- helpers ------------------------------------------------------------------
function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

function setSession(res: ServerResponse, value: string, maxAge: number): void {
  res.setHeader(
    "Set-Cookie",
    `session=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${SECURE}`,
  );
}

const JSON_TYPE = "application/json";
const BYTES_TYPE = "application/octet-stream";

// CSRF: a cross-site form can only send text/plain, urlencoded or multipart,
// and a browser always sends Origin on a cross-origin POST. Both must hold
// for every POST. File bytes go up as octet-stream, which is no weaker: it is
// not CORS-safelisted either, so a form still can't produce it.
function checkPost(req: IncomingMessage, expected = JSON_TYPE): void {
  if (req.headers.origin !== PUBLIC_ORIGIN)
    throw new HttpError(403, "bad origin");
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== expected) throw new HttpError(415, `expected ${expected}`);
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBytes(req, BODY_LIMIT);
  try {
    const body: unknown = JSON.parse(raw.toString());
    if (body && typeof body === "object" && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "invalid JSON body");
}

// A file upload is the only body here big enough to matter, and the API
// container has 128 MiB (an OOM restart also resets the login rate limit).
// Let a few land at once and make the rest wait rather than queue in memory.
const MAX_UPLOADS = 3;
let uploads = 0;
const waiting: (() => void)[] = [];

async function withUploadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (uploads >= MAX_UPLOADS) await new Promise<void>((go) => waiting.push(go));
  uploads++;
  try {
    return await run();
  } finally {
    uploads--;
    waiting.shift()?.();
  }
}

// --- routes -------------------------------------------------------------------
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { method } = req;
  const { pathname, searchParams } = new URL(
    req.url ?? "/",
    "http://localhost",
  );
  // The one route that takes raw bytes; everything else is JSON.
  const upload = pathname === "/api/private/fs/write";
  if (method === "POST") checkPost(req, upload ? BYTES_TYPE : JSON_TYPE);

  if (method === "GET" && pathname === "/api/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const client = rateKey(clientIp(req));
    // Per client first: a blocked client doesn't use up the global budget.
    if (
      !allowed(`login:${client}`, LOGIN_ATTEMPTS, LOGIN_WINDOW) ||
      !allowed("login:global", LOGIN_ATTEMPTS_GLOBAL, LOGIN_WINDOW)
    )
      throw new HttpError(429, "too many attempts, try again later");
    const { username, password, code = "" } = await readJson(req);
    if (typeof username !== "string" || typeof password !== "string" || typeof code !== "string")
      throw new HttpError(400, "username and password required");
    // Always run scrypt, so a wrong username takes as long as a wrong password.
    // The code is checked last and fails the same way, so a right password with
    // a wrong code reveals nothing (and doesn't burn the code).
    const passwordOk = await verifyPassword(password);
    if (!passwordOk || username !== OWNER_USERNAME || !verifyTotp(code))
      throw new HttpError(401, "invalid credentials");
    attempts.delete(`login:${client}`); // the limit is for guessing, not for logging in often
    setSession(res, signSession(username), SESSION_MAX_AGE);
    res.writeHead(204).end();
    return;
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    setSession(res, "", 0);
    res.writeHead(204).end();
    return;
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    json(res, 200, { username: requireSession(req) });
    return;
  }

  // Private app routes go under /api/private/ and start with requireSession(req).
  if (method === "GET" && pathname === "/api/private/ping") {
    const user = requireSession(req);
    json(res, 200, { ok: true, user });
    return;
  }

  if (pathname.startsWith("/api/private/sl/")) {
    requireSession(req);
    const route = slRoute(method, pathname, searchParams);
    if (!route) throw new HttpError(404, "not found");
    const { status, body } = await callSimpleLogin(route);
    json(res, status, body);
    return;
  }

  // --- cloud filesystem (src/kernel/fs/drivers/remotefs.ts mounts this at
  // /mnt/cloud). The session is the gate; everything else is shape checking.
  if (pathname.startsWith("/api/private/fs/")) {
    const owner = requireSession(req);
    if (!allowed(`fs:${rateKey(clientIp(req))}`, FS_REQUESTS, FS_WINDOW))
      throw new HttpError(429, "too many requests, slow down");
    const at = () => requirePath(searchParams.get("path"));

    if (method === "GET" && pathname === "/api/private/fs/list") {
      json(res, 200, { entries: cloud.list(owner, at()) });
      return;
    }
    if (method === "GET" && pathname === "/api/private/fs/stat") {
      json(res, 200, cloud.stat(owner, at()));
      return;
    }
    if (method === "GET" && pathname === "/api/private/fs/usage") {
      const { bytes, nodes } = cloud.usage(owner);
      json(res, 200, { bytes, nodes, maxBytes: cloud.MAX_TOTAL, maxNodes: cloud.MAX_NODES });
      return;
    }
    if (method === "GET" && pathname === "/api/private/fs/read") {
      const { data, version } = cloud.read(owner, at());
      res
        .writeHead(200, {
          "Content-Type": BYTES_TYPE,
          "Content-Length": String(data.byteLength),
          "X-Fs-Version": String(version),
        })
        .end(data);
      return;
    }
    if (method === "POST" && pathname === "/api/private/fs/write") {
      const path = at();
      // Absent: replace whatever is there (see fsstore.write).
      const base = searchParams.get("baseVersion");
      if (base !== null && !/^\d{1,15}$/.test(base))
        throw new HttpError(400, "invalid baseVersion");
      // Read the body first: the store's checks are only race-free with no
      // await between them and the write they guard.
      const data = await withUploadSlot(() => readBytes(req, cloud.MAX_FILE + 1024));
      json(res, 200, { version: cloud.write(owner, path, data, base === null ? null : Number(base)) });
      return;
    }
    if (method === "POST" && pathname === "/api/private/fs/mkdir") {
      const { path } = await readJson(req);
      cloud.mkdir(owner, requirePath(path));
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && pathname === "/api/private/fs/remove") {
      const { path } = await readJson(req);
      cloud.remove(owner, requirePath(path));
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && pathname === "/api/private/fs/move") {
      const { from, to } = await readJson(req);
      cloud.move(owner, requirePath(from, "from"), requirePath(to, "to"));
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(404, "not found");
  }

  if (method === "POST" && pathname === "/api/private/net/fetch") {
    requireSession(req);
    const { url, method: upMethod, body, contentType } = await readJson(req);
    if (typeof url !== "string") throw new HttpError(400, "url required");
    const out = await netFetch({
      url,
      method: typeof upMethod === "string" ? upMethod : undefined,
      body: typeof body === "string" ? body : undefined,
      contentType: typeof contentType === "string" ? contentType : undefined,
    });
    res
      .writeHead(200, {
        "Content-Type": "application/octet-stream",
        "X-Net-Status": String(out.status),
        "X-Net-Content-Type": out.contentType.replace(/[^\x20-\x7e]/g, ""),
      })
      .end(out.body);
    return;
  }

  throw new HttpError(404, "not found");
}

createServer((req, res) => {
  // API responses are per-user and never cacheable, errors included.
  res.setHeader("Cache-Control", "no-store");
  handle(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) {
      // 413: stop reading the rest of an oversized body.
      if (err.status === 413) res.setHeader("Connection", "close");
      json(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message });
      return;
    }
    // Never logs the request body (passwords): only the error and route.
    console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
}).listen(PORT, () => console.log(`api listening on :${PORT}`));
