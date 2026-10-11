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
const { signSession, verifySession, verifyPassword, SESSION_MAX_AGE } =
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
  "not-an-ip",
]) {
  assert.equal(isPrivate(a), true, `private: ${a}`);
}
for (const a of ["140.82.112.3", "2606:4700::6810:84e5"])
  assert.equal(isPrivate(a), false, `public: ${a}`);

console.log("selftest ok");
