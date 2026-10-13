// The dev toolbox: shared by json, base64, jwt, urlencode, uuid, epoch and
// the Dev Toolbox app. Pure functions, no os and no DOM, so node can check them.

export type Result = { ok: true; out: string } | { ok: false; error: string };

const fail = (error: unknown): Result => ({ ok: false, error: (error as Error).message });

// ----------------------------------------------------------------- json --

/** Pretty-prints (indent > 0) or minifies (indent 0). Errors name the line and column. */
export function formatJson(text: string, indent = 2): Result {
  try {
    return { ok: true, out: JSON.stringify(JSON.parse(text), null, indent) };
  } catch (error) {
    const message = (error as Error).message;
    // V8 says "... at position 12" (sometimes "(line 2 column 5)" too); turn the offset into line:col.
    const at = /position (\d+)/.exec(message);
    if (!at) return { ok: false, error: message };
    const before = text.slice(0, Number(at[1])).split("\n");
    const where = `line ${before.length} col ${before[before.length - 1]!.length + 1}`;
    return { ok: false, error: `${where}: ${message.replace(/ in JSON at position.*$/, "")}` };
  }
}

// --------------------------------------------------------------- base64 --

export function bytesToBase64(bytes: Uint8Array, url = false): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return url ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}

/** Accepts standard or url-safe alphabets, padded or not, with whitespace. */
export function base64ToBytes(text: string): Uint8Array {
  let b64 = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64); // throws on anything outside the alphabet
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function b64encode(text: string, url = false): string {
  return bytesToBase64(new TextEncoder().encode(text), url);
}

export function b64decode(text: string): Result {
  try {
    return { ok: true, out: new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(text)) };
  } catch (error) {
    return fail(error instanceof TypeError ? new Error("not UTF-8 text") : new Error("invalid base64"));
  }
}

// ------------------------------------------------------------------ jwt --

export interface Jwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  /** exp/nbf/iat as dates, when present. */
  times: { exp?: Date; nbf?: Date; iat?: Date };
  expired: boolean;
}

/** Decodes without verifying: checking the signature needs the key. */
export function decodeJwt(token: string, now = Date.now()): Jwt {
  const parts = token.trim().replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) throw new Error(`expected 3 dot-separated parts, got ${parts.length}`);
  const part = (i: number, name: string): Record<string, unknown> => {
    const text = b64decode(parts[i]!);
    if (!text.ok) throw new Error(`${name}: ${text.error}`);
    try {
      return JSON.parse(text.out);
    } catch {
      throw new Error(`${name}: not JSON`);
    }
  };
  const header = part(0, "header");
  const payload = part(1, "payload");
  const times: Jwt["times"] = {};
  for (const claim of ["exp", "nbf", "iat"] as const)
    if (typeof payload[claim] === "number") times[claim] = new Date((payload[claim] as number) * 1000);
  return { header, payload, signature: parts[2]!, times, expired: !!times.exp && times.exp.getTime() < now };
}

// ------------------------------------------------------------------ url --

/** `whole`: encodeURI, which keeps :/?#&= so a full URL stays a URL. */
export function urlEncode(text: string, whole = false): string {
  return whole ? encodeURI(text) : encodeURIComponent(text);
}

export function urlDecode(text: string): Result {
  try {
    // Form encoding writes spaces as +.
    return { ok: true, out: decodeURIComponent(text.replace(/\+/g, " ")) };
  } catch {
    return { ok: false, error: "malformed %-escape" };
  }
}

// ----------------------------------------------------------------- uuid --

export function uuidV4(): string {
  return crypto.randomUUID();
}

/** RFC 9562 v7: 48-bit unix ms, then random; sorts by creation time. */
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ------------------------------------------------------------------ time --

/**
 * "now", unix seconds, unix ms or anything Date parses (ISO 8601).
 * ponytail: a bare number under 1e11 is seconds, else ms — wrong only for ms before 1973.
 */
export function parseTime(input: string, now = Date.now()): Date {
  const text = input.trim();
  if (text === "" || text === "now") return new Date(now);
  const date = /^-?\d+(\.\d+)?$/.test(text)
    ? new Date(Math.abs(Number(text)) < 1e11 ? Number(text) * 1000 : Number(text))
    : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`can't read "${input}" as a time`);
  return date;
}

/** "3 hours ago" / "in 2 days". */
export function relative(date: Date, now = Date.now()): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

/** The rows epoch prints and the Timestamp tab shows. */
export function timeRows(date: Date, now = Date.now()): [string, string][] {
  return [
    ["unix", String(Math.floor(date.getTime() / 1000))],
    ["ms", String(date.getTime())],
    ["iso", date.toISOString()],
    ["local", date.toString()],
    ["relative", relative(date, now)],
  ];
}
