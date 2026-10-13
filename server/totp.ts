// TOTP (authenticator app codes) for the owner login. Run as a CLI to make
// OWNER_TOTP_SECRET and the otpauth:// URI to add to the app:
//   node server/totp.ts [username]
// Scan instead of typing: qrencode -t ansiutf8 '<uri>'
import { Secret, TOTP } from "otpauth";

const totpFor = (secret: Secret, label: string) =>
  new TOTP({ issuer: "portfolio", label, secret }); // SHA1, 6 digits, 30 s

/**
 * Checks a code against a base32 secret: one step of clock drift either way, and
 * each code works once (no replay of a code seen over someone's shoulder).
 * ponytail: lastStep lives in memory; a restart allows one replay within 90 s.
 */
export function totpVerifier(base32: string): (code: string, now?: number) => boolean {
  const totp = totpFor(Secret.fromBase32(base32), "owner");
  let lastStep = -1;
  return (code, now = Date.now()) => {
    const delta = totp.validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return false;
    const step = totp.counter({ timestamp: now }) + delta;
    if (step <= lastStep) return false;
    lastStep = step;
    return true;
  };
}

if (import.meta.main) {
  const secret = new Secret();
  console.log(`OWNER_TOTP_SECRET=${secret.base32}`);
  console.log(totpFor(secret, process.argv[2] ?? "owner").toString());
}
