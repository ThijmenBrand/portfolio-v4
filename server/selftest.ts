// Self-check for the auth primitives: node server/selftest.ts (exits non-zero on failure).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptKey } from "./hash.ts";

const salt = randomBytes(16);
process.env.OWNER_USERNAME = "owner";
process.env.OWNER_PASSWORD_HASH = `${salt.toString("hex")}:${(await scryptKey("hunter2", salt)).toString("hex")}`;
process.env.SESSION_SECRET = "x".repeat(32);
process.env.PUBLIC_ORIGIN = "http://localhost:5173";
process.env.CLOUD_DB = ":memory:";
const docs = mkdtempSync(join(tmpdir(), "cloud-docs-"));
process.env.CLOUD_DOCS = docs;
process.env.CLOUD_QUOTA_MB = "48";
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
/** What a file holds: read back from the documents directory. */
const bytes = (owner: string, path: string): Buffer => {
  const file = cloud.read(owner, path);
  try {
    return readFileSync(file.fd);
  } finally {
    closeSync(file.fd);
  }
};
const text = (owner: string, path: string): string => bytes(owner, path).toString();
/** What main.ts's receive() makes of an upload: a file in the documents directory. */
const put = (data: string | Buffer) => cloud.putBlob(Buffer.from(data));
const onDisk = () => readdirSync(docs).length;

cloud.mkdir("me", "/app");
assert.equal(code(() => cloud.mkdir("me", "/app")), "EEXIST", "mkdir twice");
assert.equal(code(() => cloud.mkdir("me", "/gone/deep")), "ENOENT", "parent must exist");
assert.equal(code(() => cloud.mkdir("me", "/app/f/x")), "ENOENT", "parent must be a directory");

// write() has three modes, and which one a caller may use depends entirely
// on what it knows. 0: it must not exist yet.
const v1 = cloud.write("me", "/app/notes.md", put("one"), 0);
assert.equal(v1, 1, "create");
assert.equal(code(() => cloud.write("me", "/app/notes.md", put("x"), 0)), "EEXIST", "create twice");
assert.equal(text("me", "/app/notes.md"), "one");

// A version: it must still be at that version. This is the one that protects
// a read-modify-write, and only a caller that read the file can ask for it.
const v2 = cloud.write("me", "/app/notes.md", put("two"), v1);
assert.equal(v2, 2, "version bumps");
assert.equal(code(() => cloud.write("me", "/app/notes.md", put("stale"), v1)), "EBUSY");
assert.equal(text("me", "/app/notes.md"), "two", "the loser changed nothing");

// null: a plain save. The caller never read what was there, so it has no
// version to stand on; last writer wins, and it creates when absent.
assert.equal(cloud.write("me", "/app/notes.md", put("three"), null), 3, "replace");
assert.equal(text("me", "/app/notes.md"), "three");
assert.equal(cloud.write("me", "/app/fresh.md", put("new"), null), 1, "replace creates");

assert.equal(code(() => cloud.write("me", "/app/missing", put("x"), 1)), "ENOENT");
assert.equal(code(() => cloud.write("me", "/app", put("x"), 1)), "EISDIR");
assert.equal(code(() => cloud.read("me", "/app")), "EISDIR");

assert.deepEqual(cloud.list("me", "/app").map((e) => e.name), ["fresh.md", "notes.md"]);
assert.equal(code(() => cloud.list("me", "/app/notes.md")), "ENOTDIR");
assert.equal(code(() => cloud.remove("me", "/app")), "ENOTEMPTY", "rmdir is not recursive");
assert.equal(code(() => cloud.remove("me", "/")), "EBUSY", "the root stays");

// One owner cannot see another's tree, even at the same path.
assert.equal(code(() => cloud.list("you", "/app")), "ENOENT");
cloud.mkdir("you", "/app");
cloud.write("you", "/app/notes.md", put("theirs"), null);
assert.equal(text("me", "/app/notes.md"), "three", "tree per owner");

// The LIKE trap: % and _ are wildcards and LIKE folds ASCII case, so a
// recursive match written with LIKE would delete the wrong rows.
for (const dir of ["/a_b", "/axb", "/Notes", "/notes"]) cloud.mkdir("me", dir);
for (const dir of ["/a_b", "/axb", "/Notes", "/notes"])
  cloud.write("me", `${dir}/x`, put(dir), null);
cloud.move("me", "/a_b", "/moved_underscore");
assert.equal(text("me", "/axb/x"), "/axb", "_ is not a wildcard");
assert.equal(text("me", "/moved_underscore/x"), "/a_b");
cloud.move("me", "/Notes", "/moved_case");
assert.equal(text("me", "/notes/x"), "/notes", "case is not folded");

// Moving a directory takes its subtree and rejects moving into itself.
cloud.mkdir("me", "/app/sub");
cloud.write("me", "/app/sub/deep.txt", put("deep"), null);
assert.equal(code(() => cloud.move("me", "/app", "/app/sub")), "EINVAL", "into itself");
cloud.move("me", "/app", "/archive");
assert.equal(text("me", "/archive/sub/deep.txt"), "deep");
assert.equal(code(() => cloud.stat("me", "/app")), "ENOENT", "old path is gone");
assert.deepEqual(cloud.list("me", "/archive").map((e) => e.name).sort(), ["fresh.md", "notes.md", "sub"]);

// Every file's bytes are a file of their own, which its row owns: written
// before it commits, deleted once nothing points at it. So the documents
// directory holds exactly one file per file row, whatever happened.
const fileRows = () =>
  (cloud.db.prepare("SELECT COUNT(*) AS n FROM node WHERE kind = 'file'").get() as { n: number }).n;
const balanced = (what: string) => assert.equal(onDisk(), fileRows(), what);
balanced("every write so far, replaced ones included");
assert.equal(
  (cloud.db.prepare("SELECT COUNT(*) AS n FROM node WHERE data IS NOT NULL").get() as { n: number }).n,
  0,
  "no bytes in the database",
);

const big = Buffer.alloc(2 * 1024 * 1024 + 1, 7);
assert.equal(cloud.write("me", "/archive/slides.pdf", put(big), 0), 1);
balanced("a new file");
assert.equal(cloud.stat("me", "/archive/slides.pdf").size, big.byteLength, "size from the row");
assert.ok(bytes("me", "/archive/slides.pdf").equals(big), "read back from disk");
assert.ok(cloud.usage("me").bytes >= big.byteLength, "counts toward the quota");

assert.equal(code(() => cloud.write("me", "/archive/slides.pdf", put(big), 0)), "EEXIST");
balanced("a refused upload's file is deleted");

// A read in progress keeps its bytes when the file is replaced under it.
const reading = cloud.read("me", "/archive/slides.pdf");
cloud.write("me", "/archive/slides.pdf", put("small now"), null);
balanced("replaced: the old file goes");
assert.ok(readFileSync(reading.fd).equals(big), "the open read still has it");
closeSync(reading.fd);
assert.equal(text("me", "/archive/slides.pdf"), "small now");

cloud.write("me", "/archive/a.pdf", put(big), null);
cloud.write("me", "/archive/b.pdf", put(Buffer.alloc(big.byteLength + 1, 9)), null);
cloud.move("me", "/archive/a.pdf", "/archive/moved.pdf");
assert.ok(bytes("me", "/archive/moved.pdf").equals(big), "a move keeps the file");
cloud.move("me", "/archive/moved.pdf", "/archive/b.pdf");
balanced("moving onto a file deletes the one it replaced");
assert.ok(bytes("me", "/archive/b.pdf").equals(big));
cloud.remove("me", "/archive/b.pdf");
balanced("removing deletes it");

// A database from before: bytes in the row, no file. And a row an older
// image wrote after a rollback: fresh bytes in the row, a stale file.
const legacy = cloud.db.prepare(
  "INSERT INTO node (owner, parent, path, kind, data, version, created_at, modified_at) VALUES ('me', '/archive', ?, 'file', ?, 1, 0, 0)",
);
legacy.run("/archive/old.json", Buffer.from('{"old":true}'));
legacy.run("/archive/empty.txt", null);
cloud.db
  .prepare("UPDATE node SET data = ? WHERE owner = 'me' AND path = '/archive/notes.md'")
  .run(Buffer.from("written by an older image"));
assert.equal(cloud.migrateInline(), 3, "moves exactly the rows with bytes or no file");
assert.equal(cloud.migrateInline(), 0, "and only once");
assert.equal(text("me", "/archive/old.json"), '{"old":true}');
assert.equal(cloud.stat("me", "/archive/old.json").size, 12);
assert.equal(text("me", "/archive/empty.txt"), "");
assert.equal(text("me", "/archive/notes.md"), "written by an older image", "the row's bytes win");
balanced("migrated, and the stale file is gone");

// Quota: per file, and in total.
assert.equal(
  code(() => cloud.write("me", "/archive/big", put(Buffer.alloc(cloud.MAX_FILE + 1)), null)),
  "EFBIG",
);
balanced("an oversized upload's file is deleted");
const chunk = Buffer.alloc(cloud.MAX_FILE);
let filled = 0;
for (let i = 0; filled <= cloud.MAX_TOTAL; i++) {
  const failure = code(() => cloud.write("me", `/archive/fill${i}`, put(chunk), null));
  if (failure === "ENOSPC") break;
  assert.equal(failure, undefined, `fill ${i}`);
  filled += chunk.byteLength;
}
assert.ok(filled > 0 && filled <= cloud.MAX_TOTAL, "stopped at the quota");
assert.ok(cloud.usage("me").bytes <= cloud.MAX_TOTAL, "never over");
balanced("the refused one left nothing behind");
rmSync(docs, { recursive: true });

console.log("selftest ok");
