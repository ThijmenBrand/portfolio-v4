// Self-check for dev.ts: `node src/bin/lib/dev.check.ts` (or `pnpm check`).
import { b64decode, b64encode, decodeJwt, formatJson, parseTime, urlDecode, urlEncode, uuidV4, uuidV7 } from "./dev.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

// json
eq(formatJson('{"a":[1,2]}'), { ok: true, out: '{\n  "a": [\n    1,\n    2\n  ]\n}' }, "json: pretty");
eq(formatJson('{ "a": 1 }', 0), { ok: true, out: '{"a":1}' }, "json: minify");
const bad = formatJson('{\n  "a": 1,\n  }');
eq(!bad.ok && bad.error.startsWith("line 3 col 3:"), true, `json: error position (${!bad.ok && bad.error})`);

// base64
eq(b64encode("héllo 🚀"), "aMOpbGxvIPCfmoA=", "base64: utf-8");
eq(b64decode("aMOpbGxvIPCfmoA="), { ok: true, out: "héllo 🚀" }, "base64: round trip");
eq(b64encode("??>", true), "Pz8-", "base64: url-safe, unpadded");
eq(b64decode("Pz8-"), { ok: true, out: "??>" }, "base64: url-safe decode");
eq(b64decode("a"), { ok: false, error: "invalid base64" }, "base64: bad input");

// jwt
const jwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  b64encode(JSON.stringify({ sub: "42", exp: 1700000000 }), true) +
  ".sig";
const decoded = decodeJwt(`Bearer ${jwt}`, 1800000000000);
eq(decoded.header, { alg: "HS256", typ: "JWT" }, "jwt: header");
eq(decoded.payload.sub, "42", "jwt: payload");
eq(decoded.expired, true, "jwt: expired");
eq(decoded.times.exp?.toISOString(), "2023-11-14T22:13:20.000Z", "jwt: exp date");
let threw = false;
try {
  decodeJwt("a.b");
} catch {
  threw = true;
}
eq(threw, true, "jwt: two parts throws");

// url
eq(urlEncode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9", "url: component");
eq(urlEncode("https://x.dev/a b?q=1"), "https%3A%2F%2Fx.dev%2Fa%20b%3Fq%3D1", "url: component of url");
eq(urlEncode("https://x.dev/a b?q=1", true), "https://x.dev/a%20b?q=1", "url: whole");
eq(urlDecode("a+b%20c"), { ok: true, out: "a b c" }, "url: decode + and %20");
eq(urlDecode("%E0%A4%A").ok, false, "url: malformed");

// uuid
const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-([47])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
eq(shape.exec(uuidV4())?.[1], "4", "uuid: v4 shape");
eq(shape.exec(uuidV7())?.[1], "7", "uuid: v7 shape");
eq(uuidV7(0x0123456789ab).slice(0, 13), "01234567-89ab", "uuid: v7 timestamp prefix");

// time
eq(parseTime("1700000000").toISOString(), "2023-11-14T22:13:20.000Z", "time: seconds");
eq(parseTime("1700000000123").toISOString(), "2023-11-14T22:13:20.123Z", "time: ms");
eq(parseTime("2023-11-14T22:13:20Z").getTime(), 1700000000000, "time: iso");
eq(parseTime("now", 5).getTime(), 5, "time: now");

console.log(`dev.check: ${count} ok`);
