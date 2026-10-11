// Password hashing for the owner login. Run as a CLI to make OWNER_PASSWORD_HASH,
// with the password on stdin (never argv: shell history, ps):
//   read -rs PW && printf '%s' "$PW" | node server/hash.ts    → salthex:hashhex
import { randomBytes, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";

/** scrypt with Node's defaults (N=16384, r=8, p=1), 64-byte key. auth.ts verifies with this too. */
export function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

if (import.meta.main) {
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!password || process.argv.length > 2) {
    console.error(`usage: read -rs PW && printf '%s' "$PW" | node server/hash.ts`);
    process.exit(1);
  }
  const salt = randomBytes(16);
  console.log(`${salt.toString("hex")}:${(await scryptKey(password, salt)).toString("hex")}`);
}
