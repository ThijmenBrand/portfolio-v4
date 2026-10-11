/**
 * Unix permission bits. Pure: the VFS keeps the attributes, this decides.
 *
 * ponytail: one group per process (no supplementary groups), no sticky bit,
 * no umask. Add them when something needs them.
 */

/** Who is asking: a process's effective uid and its group. */
export type Cred = { euid: number; gid: number };

export type Attr = { uid: number; gid: number; mode: number };

export const R = 4;
export const W = 2;
export const X = 1;

export const ROOT: Cred = { euid: 0, gid: 0 };

/** The owner's group, in /etc/group as `admin`. Its members see private apps. */
export const ADMIN_GID = 10;

export function defaultAttr(kind: string): Attr {
  return { uid: 0, gid: 0, mode: kind === "file" ? 0o644 : 0o755 };
}

/** Root may do anything; otherwise owner, group or other bits, in that order. */
export function permits(attr: Attr, cred: Cred, want: number): boolean {
  if (cred.euid === 0) return true;
  const shift =
    cred.euid === attr.uid ? 6 : cred.gid === attr.gid ? 3 : 0;
  return ((attr.mode >> shift) & want) === want;
}

// Self-check: node src/kernel/fs/perm.ts
if ((import.meta as { main?: boolean }).main) {
  // No node:assert: tsc here only knows the browser's types.
  const assert = (ok: boolean, what = "") => {
    if (!ok) throw new Error(`perm self-check failed: ${what}`);
  };
  const file = { uid: 1000, gid: 1000, mode: 0o640 };
  assert(permits(file, { euid: 1000, gid: 1000 }, R | W), "owner rw");
  assert(!permits(file, { euid: 1000, gid: 1000 }, X), "owner no x");
  assert(permits(file, { euid: 1001, gid: 1000 }, R), "group r");
  assert(!permits(file, { euid: 1001, gid: 1000 }, W), "group no w");
  assert(!permits(file, { euid: 1001, gid: 1001 }, R), "other nothing");
  assert(permits(file, ROOT, R | W | X), "root anything");
  // Owner bits win even when they're stricter than the group's.
  assert(!permits({ uid: 1, gid: 1, mode: 0o070 }, { euid: 1, gid: 1 }, R));
  console.log("perm: ok");
}
