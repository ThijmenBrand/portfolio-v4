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
const { signSession, verifySession, verifyPassword, SESSION_MAX_AGE } = await import("./auth.ts");

const token = signSession("owner");
assert.equal(verifySession(token), "owner", "valid session");

const [payload, mac] = token.split(".") as [string, string];
const forged = Buffer.from(JSON.stringify({ u: "admin", exp: Date.now() + 1e9 })).toString("base64url");
assert.equal(verifySession(`${forged}.${mac}`), null, "tampered payload");
assert.equal(verifySession(`${payload}.${mac.slice(0, -2)}AA`), null, "tampered mac");
assert.equal(verifySession(payload), null, "missing mac");

const expired = signSession("owner", Date.now() - SESSION_MAX_AGE * 1000 - 1);
assert.equal(verifySession(expired), null, "expired session");

assert.equal(await verifyPassword("hunter2"), true, "right password");
assert.equal(await verifyPassword("hunter3"), false, "wrong password");

console.log("selftest ok");
