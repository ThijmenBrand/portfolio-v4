// Self-check for the auth primitives: node server/selftest.ts (exits non-zero on failure).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scryptKey } from "./hash.ts";

const salt = randomBytes(16);
process.env.OWNER_USERNAME = "owner";
process.env.OWNER_PASSWORD_HASH = `${salt.toString("hex")}:${(await scryptKey("hunter2", salt)).toString("hex")}`;
process.env.SESSION_SECRET = "x".repeat(32);
process.env.PUBLIC_ORIGIN = "http://localhost:5173";
process.env.CLOUD_DB = ":memory:";
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

// --- cloud filesystem paths ---------------------------------------------------
const { isValidPath, parentOf, nameOf, isUnder } = await import("./fspath.ts");
for (const good of ["/", "/a", "/a/b.txt", "/a/.hidden", "/a/b c", "/\u00e9t\u00e9"])
  assert.equal(isValidPath(good), true, `valid: ${good}`);
for (const bad of [
  "",            // empty
  "a/b",         // not absolute
  "/a/",         // trailing slash
  "/a//b",       // empty segment
  "/a/./b",      // dot
  "/a/../b",     // dot dot
  "/..",
  "/a\\b",       // backslash
  "/a\u0000b",    // NUL
  "/a\nb",        // control character
  "/a\u007fb",    // DEL
  `/${"x".repeat(256)}`,          // segment too long
  `/${Array(33).fill("a").join("/")}`, // too deep
  `/${"a/".repeat(400)}b`,        // path too long
])
  assert.equal(isValidPath(bad), false, `invalid: ${JSON.stringify(bad)}`);
// The validator rejects rather than rewrites, so these stay distinct keys.
assert.equal(isValidPath("/caf\u00e9"), true);
assert.equal(isValidPath("/cafe\u0301"), true, "NFD is a different, equally valid key");

assert.equal(parentOf("/a/b/c"), "/a/b");
assert.equal(parentOf("/a"), "/");
assert.equal(nameOf("/a/b"), "b");
assert.equal(isUnder("/a/b", "/a"), true);
assert.equal(isUnder("/ab", "/a"), false, "prefix is not a parent");
assert.equal(isUnder("/anything", "/"), true);

// --- cloud filesystem store ---------------------------------------------------
const cloud = await import("./fsstore.ts");
const code = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

cloud.mkdir("me", "/app");
assert.equal(code(() => cloud.mkdir("me", "/app")), "EEXIST", "mkdir twice");
assert.equal(code(() => cloud.mkdir("me", "/gone/deep")), "ENOENT", "parent must exist");
assert.equal(code(() => cloud.mkdir("me", "/app/f/x")), "ENOENT", "parent must be a directory");

// write() has three modes, and which one a caller may use depends entirely
// on what it knows. 0: it must not exist yet.
const v1 = cloud.write("me", "/app/notes.md", Buffer.from("one"), 0);
assert.equal(v1, 1, "create");
assert.equal(code(() => cloud.write("me", "/app/notes.md", Buffer.from("x"), 0)), "EEXIST", "create twice");
assert.equal(cloud.read("me", "/app/notes.md").data.toString(), "one");

// A version: it must still be at that version. This is the one that protects
// a read-modify-write, and only a caller that read the file can ask for it.
const v2 = cloud.write("me", "/app/notes.md", Buffer.from("two"), v1);
assert.equal(v2, 2, "version bumps");
assert.equal(code(() => cloud.write("me", "/app/notes.md", Buffer.from("stale"), v1)), "EBUSY");
assert.equal(cloud.read("me", "/app/notes.md").data.toString(), "two", "the loser changed nothing");

// null: a plain save. The caller never read what was there, so it has no
// version to stand on; last writer wins, and it creates when absent.
assert.equal(cloud.write("me", "/app/notes.md", Buffer.from("three"), null), 3, "replace");
assert.equal(cloud.read("me", "/app/notes.md").data.toString(), "three");
assert.equal(cloud.write("me", "/app/fresh.md", Buffer.from("new"), null), 1, "replace creates");

assert.equal(code(() => cloud.write("me", "/app/missing", Buffer.from("x"), 1)), "ENOENT");
assert.equal(code(() => cloud.write("me", "/app", Buffer.from("x"), 1)), "EISDIR");
assert.equal(code(() => cloud.read("me", "/app")), "EISDIR");

assert.deepEqual(cloud.list("me", "/app").map((e) => e.name), ["fresh.md", "notes.md"]);
assert.equal(code(() => cloud.list("me", "/app/notes.md")), "ENOTDIR");
assert.equal(code(() => cloud.remove("me", "/app")), "ENOTEMPTY", "rmdir is not recursive");
assert.equal(code(() => cloud.remove("me", "/")), "EBUSY", "the root stays");

// One owner cannot see another's tree, even at the same path.
assert.equal(code(() => cloud.list("you", "/app")), "ENOENT");
cloud.mkdir("you", "/app");
cloud.write("you", "/app/notes.md", Buffer.from("theirs"), null);
assert.equal(cloud.read("me", "/app/notes.md").data.toString(), "three", "tree per owner");

// The LIKE trap: % and _ are wildcards and LIKE folds ASCII case, so a
// recursive match written with LIKE would delete the wrong rows.
for (const dir of ["/a_b", "/axb", "/Notes", "/notes"]) cloud.mkdir("me", dir);
for (const dir of ["/a_b", "/axb", "/Notes", "/notes"])
  cloud.write("me", `${dir}/x`, Buffer.from(dir), null);
cloud.move("me", "/a_b", "/moved_underscore");
assert.equal(cloud.read("me", "/axb/x").data.toString(), "/axb", "_ is not a wildcard");
assert.equal(cloud.read("me", "/moved_underscore/x").data.toString(), "/a_b");
cloud.move("me", "/Notes", "/moved_case");
assert.equal(cloud.read("me", "/notes/x").data.toString(), "/notes", "case is not folded");

// Moving a directory takes its subtree and rejects moving into itself.
cloud.mkdir("me", "/app/sub");
cloud.write("me", "/app/sub/deep.txt", Buffer.from("deep"), null);
assert.equal(code(() => cloud.move("me", "/app", "/app/sub")), "EINVAL", "into itself");
cloud.move("me", "/app", "/archive");
assert.equal(cloud.read("me", "/archive/sub/deep.txt").data.toString(), "deep");
assert.equal(code(() => cloud.stat("me", "/app")), "ENOENT", "old path is gone");
assert.deepEqual(cloud.list("me", "/archive").map((e) => e.name).sort(), ["fresh.md", "notes.md", "sub"]);

// Quota: per file, and in total.
assert.equal(
  code(() => cloud.write("me", "/archive/big", Buffer.alloc(cloud.MAX_FILE + 1), null)),
  "EFBIG",
);
const chunk = Buffer.alloc(cloud.MAX_FILE);
let filled = 0;
for (let i = 0; filled <= cloud.MAX_TOTAL; i++) {
  const failure = code(() => cloud.write("me", `/archive/fill${i}`, chunk, null));
  if (failure === "ENOSPC") break;
  assert.equal(failure, undefined, `fill ${i}`);
  filled += chunk.byteLength;
}
assert.ok(filled > 0 && filled <= cloud.MAX_TOTAL, "stopped at the quota");
assert.ok(cloud.usage("me").bytes <= cloud.MAX_TOTAL, "never over");

console.log("selftest ok");
