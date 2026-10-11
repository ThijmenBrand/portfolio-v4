// Password hashing for the owner login. Run as a CLI to make OWNER_PASSWORD_HASH:
//   node server/hash.ts <password>    → salthex:hashhex
import { randomBytes, scrypt } from "node:crypto";

/** scrypt with Node's defaults (N=16384, r=8, p=1), 64-byte key. auth.ts verifies with this too. */
export function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

if (import.meta.main) {
  const password = process.argv[2];
  if (!password) {
    console.error("usage: node server/hash.ts <password>");
    process.exit(1);
  }
  const salt = randomBytes(16);
  console.log(`${salt.toString("hex")}:${(await scryptKey(password, salt)).toString("hex")}`);
}
