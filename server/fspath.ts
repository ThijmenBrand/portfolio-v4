// Path rules for the cloud filesystem (server/fsstore.ts).
//
// Paths are database keys, never filesystem paths, so there is nothing to
// traverse out of. What these rules protect is agreement: the kernel's VFS
// normalizes paths its own way (src/kernel/fs/path.ts), and if the server
// quietly rewrote them too the two would drift apart and a node would end up
// keyed differently from the entry the browser thinks it wrote. So this
// REJECTS anything not already in canonical form; it never rewrites.
//
// Deliberately not done: Unicode (NFC) folding and case folding. The VFS and
// OPFS don't fold either, and folding on one side only would reintroduce
// exactly the drift above. Two visually identical siblings are a wart, not a
// hole: the store's collation is binary, so they stay separate nodes.
import { HttpError } from "./auth.ts";

const MAX_PATH = 1024; // bytes
const MAX_SEGMENT = 255; // bytes, like a Unix filename
const MAX_DEPTH = 32;

/** The root is the one path with no name and no parent; it always exists. */
export const ROOT = "/";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * True for a path this store will accept: absolute, canonical, and within the
 * size limits. The root counts.
 */
export function isValidPath(path: string): boolean {
  if (path === ROOT) return true;
  if (!path.startsWith("/") || path.endsWith("/")) return false;
  if (bytes(path) > MAX_PATH) return false;
  // Control characters and backslash: never meaningful here, and they make
  // paths unreadable (or ambiguous) everywhere they're later displayed.
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;

  const segments = path.slice(1).split("/");
  if (segments.length > MAX_DEPTH) return false;
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      bytes(segment) <= MAX_SEGMENT,
  );
}

/** The validated path, or a 400. */
export function requirePath(path: unknown, what = "path"): string {
  if (typeof path !== "string" || !isValidPath(path))
    throw new HttpError(400, `invalid ${what}`);
  return path;
}

/** "/a/b" -> "/a"; "/a" -> "/". The root has no parent. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? ROOT : path.slice(0, cut);
}

/** "/a/b" -> "b". The root has no name. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True if `path` is `root` itself or sits anywhere beneath it. */
export function isUnder(path: string, root: string): boolean {
  if (root === ROOT) return true;
  return path === root || path.startsWith(`${root}/`);
}
