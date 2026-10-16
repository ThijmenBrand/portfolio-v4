// Single-owner auth: one username + scrypt password hash from the environment,
// and a signed session cookie.
//
// ponytail: stateless sessions. Logout only clears the cookie; a stolen cookie
// stays valid until it expires (12 hours). A new password, TOTP secret or SESSION_SECRET
// kills every session at once (both key the HMAC); add a server-side session
// store if single sessions ever need revoking.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { scryptKey } from "./hash.ts";
import { totpVerifier } from "./totp.ts";

export class HttpError extends Error {
  status: number;
  /**
   * Optional kernel error code (ENOENT, ENOTDIR, ...) for callers that map a
   * failure onto a filesystem error rather than onto HTTP. The status alone
   * can't carry it: several of them share one status.
   */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Fail fast at startup rather than on the first login.
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name} (see .env.example)`);
  return value;
}
export const OWNER_USERNAME = env("OWNER_USERNAME");
export const PUBLIC_ORIGIN = env("PUBLIC_ORIGIN");
const OWNER_PASSWORD_HASH = env("OWNER_PASSWORD_HASH");
const [salt, hash] = OWNER_PASSWORD_HASH.split(":").map((h) => Buffer.from(h, "hex"));
if (!salt?.length || hash?.length !== 64) {
  throw new Error("OWNER_PASSWORD_HASH must be salthex:hashhex (password on stdin: node server/hash.ts)");
}
const SESSION_SECRET = env("SESSION_SECRET");
if (SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

// Second factor: required when set. Unset (dev without setup) skips it, loudly.
const OWNER_TOTP_SECRET = process.env.OWNER_TOTP_SECRET ?? "";
const checkTotp = OWNER_TOTP_SECRET ? totpVerifier(OWNER_TOTP_SECRET) : undefined;
if (!checkTotp) console.warn("OWNER_TOTP_SECRET not set: 2FA disabled (node server/totp.ts)");
/** True if the code is valid, or if 2FA isn't configured. */
export const verifyTotp = (code: string) => checkTotp?.(code) ?? true;

export const SESSION_MAX_AGE = 12 * 60 * 60; // seconds

// One scrypt at a time: each takes 16 MiB, and a few in parallel would push the
// API past its container memory limit (an OOM restart also resets the login
// rate limit). ponytail: global queue, ~50 ms per login; fine for one owner.
let queue: Promise<unknown> = Promise.resolve();
export function verifyPassword(password: string): Promise<boolean> {
  const key = queue.then(() => scryptKey(password, salt));
  queue = key.catch(() => {});
  return key.then((k) => timingSafeEqual(k, hash));
}

/** Rate-limit key: the IPv4 address, or the /64 of an IPv6 one (one subscriber's block). */
export function rateKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return mapped;
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// The password hash and TOTP secret key the HMAC too, so changing either signs
// out every session.
const SESSION_KEY = `${SESSION_SECRET}:${OWNER_PASSWORD_HASH}:${OWNER_TOTP_SECRET}`;
const sign = (payload: string) =>
  createHmac("sha256", SESSION_KEY).update(payload).digest("base64url");

/** Cookie value: base64url(JSON {u, exp}) "." base64url(HMAC-SHA256). exp in ms. */
export function signSession(user: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: now + SESSION_MAX_AGE * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The username, or null if the value is malformed, tampered with or expired. */
export function verifySession(value: string): string | null {
  const [payload, mac, extra] = value.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const given = Buffer.from(mac, "base64url");
  const expected = Buffer.from(sign(payload), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof u === "string" && typeof exp === "number" && exp > Date.now() ? u : null;
  } catch {
    return null;
  }
}

function sessionCookie(req: IncomingMessage): string | undefined {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const [name, ...value] = part.trim().split("=");
    if (name === "session") return value.join("=");
  }
  return undefined;
}

/** The signed-in username; throws a 401 otherwise. */
export function requireSession(req: IncomingMessage): string {
  const cookie = sessionCookie(req);
  const user = cookie ? verifySession(cookie) : null;
  if (!user) throw new HttpError(401, "unauthorized");
  return user;
}
