// ustar archives for `tar`. Pure, so tools.check.ts can test it.
// Only files and directories; paths are relative, '/'-separated.

export type Entry = { path: string; kind: "file" | "directory"; mode: number; mtime: number; data: Uint8Array<ArrayBuffer> };

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** ustar keeps 100 bytes of name plus a 155-byte prefix, split at a '/'. */
function splitPath(path: string): [prefix: string, name: string] {
  if (encoder.encode(path).length <= 100) return ["", path];
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return [prefix, name];
  }
  throw new Error(`path too long for tar: ${path}`);
}

function header(entry: Entry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  const path = entry.kind === "directory" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  const [prefix, name] = splitPath(path);
  put(name, 0);
  put(octal(entry.mode & 0o7777, 8), 100);
  put(octal(0, 8), 108); // uid
  put(octal(0, 8), 116); // gid
  put(octal(entry.kind === "file" ? entry.data.length : 0, 12), 124);
  put(octal(Math.floor(entry.mtime / 1000), 12), 136);
  put("        ", 148); // checksum counts as spaces while summing
  put(entry.kind === "file" ? "0" : "5", 156);
  put("ustar\0" + "00", 257);
  put(prefix, 345);
  const sum = block.reduce((a, b) => a + b, 0);
  put(octal(sum, 7) + " ", 148);
  return block;
}

export function pack(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (entry.kind === "file") {
      parts.push(entry.data, new Uint8Array((BLOCK - (entry.data.length % BLOCK)) % BLOCK));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
}

/** Entries other than files and directories (links, devices) are skipped. */
export function unpack(archive: Uint8Array<ArrayBuffer>): Entry[] {
  const entries: Entry[] = [];
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const block = archive.subarray(at, at + BLOCK);
    if (block.every((b) => b === 0)) break;
    const stored = parseInt(field(block, 148, 8).trim(), 8);
    const sum = block.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
    if (stored !== sum) throw new Error("not a tar archive (bad checksum)");

    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const size = parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156]!);
    at += BLOCK;
    const data = archive.slice(at, at + size);
    at += Math.ceil(size / BLOCK) * BLOCK;

    const path = (prefix ? `${prefix}/${name}` : name).replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").includes("..")) continue;
    const base = { path, mode: parseInt(field(block, 100, 8).trim() || "644", 8), mtime: parseInt(field(block, 136, 12).trim() || "0", 8) * 1000 };
    if (type === "5") entries.push({ ...base, kind: "directory", data: new Uint8Array(0) });
    else if (type === "0" || type === "\0") entries.push({ ...base, kind: "file", data });
  }
  return entries;
}

/** gzip magic: 1f 8b. Lets `tar -x` detect compression without -z. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}
