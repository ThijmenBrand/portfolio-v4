// Self-check for the auth primitives: node server/selftest.ts (exits non-zero on failure).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scryptKey } from "./hash.ts";

const salt = randomBytes(16);
process.env.OWNER_USERNAME = "owner";
process.env.OWNER_PASSWORD_HASH = `${salt.toString("hex")}:${(await scryptKey("hunter2", salt)).toString("hex")}`;
process.env.SESSION_SECRET = "x".repeat(32);
process.env.PUBLIC_ORIGIN = "http://localhost:5173";
// auth.ts reads the env on import, so import it only now.
const { signSession, verifySession, verifyPassword, rateKey, SESSION_MAX_AGE } =
  await import("./auth.ts");

const token = signSession("owner");
assert.equal(verifySession(token), "owner", "valid session");

const [payload, mac] = token.split(".") as [string, string];
const forged = Buffer.from(
  JSON.stringify({ u: "admin", exp: Date.now() + 1e9 }),
).toString("base64url");
assert.equal(verifySession(`${forged}.${mac}`), null, "tampered payload");
assert.equal(
  verifySession(`${payload}.${mac.slice(0, -2)}AA`),
  null,
  "tampered mac",
);
assert.equal(verifySession(payload), null, "missing mac");

const expired = signSession("owner", Date.now() - SESSION_MAX_AGE * 1000 - 1);
assert.equal(verifySession(expired), null, "expired session");

assert.equal(await verifyPassword("hunter2"), true, "right password");
assert.equal(await verifyPassword("hunter3"), false, "wrong password");
// Queued one at a time, but each caller still gets its own answer.
const guesses = ["hunter2", "x", "hunter2", "y", "z", "hunter2", "w", "v"];
assert.deepEqual(
  await Promise.all(guesses.map((g) => verifyPassword(g))),
  guesses.map((g) => g === "hunter2"),
  "parallel passwords",
);

// Rate limit: an IPv6 /64 is one client; IPv4-mapped is plain IPv4.
assert.equal(rateKey("1.2.3.4"), "1.2.3.4");
assert.equal(rateKey("::ffff:1.2.3.4"), "1.2.3.4", "mapped");
assert.equal(rateKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
assert.equal(rateKey("2001:0db8:1:2:ffff::9"), "2001:db8:1:2::/64", "same /64");
assert.notEqual(rateKey("2001:db8:1:3::1"), rateKey("2001:db8:1:2::1"), "other /64");
assert.equal(rateKey("::1"), "0:0:0:0::/64", "loopback");
assert.equal(rateKey("fe80::1:2:3:4"), "fe80:0:0:0::/64");

// SimpleLogin proxy: only the allowlisted calls map through.
const { slRoute } = await import("./simplelogin.ts");
const sl = (method: string, path: string) => {
  const url = new URL(path, "http://x");
  return slRoute(method, url.pathname, url.searchParams);
};
assert.deepEqual(sl("GET", "/api/private/sl/aliases?page=2&filter=pinned"), {
  method: "GET",
  path: "/api/v2/aliases?page_id=2&pinned",
});
assert.deepEqual(sl("GET", "/api/private/sl/aliases?q=shop"), {
  method: "POST",
  path: "/api/v2/aliases?page_id=0",
  body: { query: "shop" },
});
assert.deepEqual(sl("POST", "/api/private/sl/aliases/42/toggle"), {
  method: "POST",
  path: "/api/aliases/42/toggle",
});
assert.deepEqual(sl("GET", "/api/private/sl/aliases/42/contacts?page=1"), {
  method: "GET",
  path: "/api/aliases/42/contacts?page_id=1",
});
assert.deepEqual(sl("POST", "/api/private/sl/contacts/7/toggle"), {
  method: "POST",
  path: "/api/contacts/7/toggle",
});
assert.equal(
  sl("GET", "/api/private/sl/aliases/42/toggle"),
  null,
  "wrong method",
);
assert.equal(
  sl("POST", "/api/private/sl/aliases/abc/toggle"),
  null,
  "non-numeric id",
);
assert.equal(
  sl("GET", "/api/private/sl/aliases?filter=all%26x"),
  null,
  "unknown filter",
);
assert.equal(sl("GET", "/api/private/sl/aliases?page=-1"), null, "bad page");
assert.equal(sl("GET", "/api/private/sl/user_info"), null, "unlisted path");
assert.equal(
  slRoute(
    "POST",
    "/api/private/sl/aliases/1/../../user/delete",
    new URLSearchParams(),
  ),
  null,
  "traversal",
);

// TOTP: RFC 6238 SHA1 vector (secret "12345678901234567890", T=59 s → 287082).
const { totpVerifier } = await import("./totp.ts");
const RFC = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
assert.equal(totpVerifier(RFC)("287082", 59_000), true, "rfc vector");
assert.equal(totpVerifier(RFC)("287082", 59_000 + 30_000), true, "one step late");
assert.equal(totpVerifier(RFC)("287082", 59_000 + 60_000), false, "two steps late");
assert.equal(totpVerifier(RFC)("287082", 59_000 - 60_000), false, "two steps early");
assert.equal(totpVerifier(RFC)("287083", 59_000), false, "wrong code");
assert.equal(totpVerifier(RFC)("", 59_000), false, "no code");
const once = totpVerifier(RFC);
assert.equal(once("287082", 59_000), true);
assert.equal(once("287082", 60_000), false, "replay");

const { isPrivate } = await import("./net.ts");
for (const a of [
  "10.0.0.1",
  "127.0.0.1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "fd00::1",
  "::1",
  "169.254.169.254",
  "172.18.0.2",
  "::7f00:1",
  "64:ff9b::7f00:1",
  "not-an-ip",
]) {
  assert.equal(isPrivate(a), true, `private: ${a}`);
}
for (const a of ["140.82.112.3", "2606:4700::6810:84e5"])
  assert.equal(isPrivate(a), false, `public: ${a}`);

console.log("selftest ok");
