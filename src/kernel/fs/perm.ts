/**
 * Unix permission bits. Pure: the VFS keeps the attributes, this decides.
 *
 * ponytail: one group per process (no supplementary groups), no sticky bit,
 * no umask. Add them when something needs them.
 */

/**
 * Who is asking: a process's effective uid, its group, and whether it is code
 * that came out of the filesystem (a user-installed app). `Process` has all
 * three, so passing a process as a credential keeps working.
 *
 * `untrusted` is required, not optional: every VFS method defaults its
 * credential to ROOT, so an optional flag would make one forgotten argument
 * silently grant everything.
 */
export type Cred = {
  /**
   * The real uid: who started this, which `su` replaces and setuid keeps.
   * That difference is what tells "the owner ran sudo" from "a visitor ran
   * su root", and the two are indistinguishable by euid.
   */
  uid: number;
  euid: number;
  gid: number;
  untrusted: boolean;
};

export type Attr = {
  uid: number;
  gid: number;
  mode: number;
  createdAt?: number;
  modifiedAt?: number;
};

export const R = 4;
export const W = 2;
export const X = 1;

export const ROOT: Cred = { uid: 0, euid: 0, gid: 0, untrusted: false };

export const ADMIN_GID = 10;

export function defaultAttr(kind: string): Attr {
  return { uid: 0, gid: 0, mode: kind === "file" ? 0o644 : 0o755 };
}

/**
 * Permissions for everything on a server-backed mount: the admin group only,
 * at every depth. They are fixed rather than stored because the attrs map is
 * saved per browser (fs/meta.ts) while the files themselves are shared, so a
 * stored mode would differ between the very browsers the mount exists to keep
 * in sync -- and a weakened one would outlive the code that set it.
 */
export function remoteAttr(kind: string): Attr {
  // Group-writable: the mount belongs to root, but the owner is an ordinary
  // user who happens to be in the admin group, and these are their files.
  // Nothing for anyone else, at any depth.
  return { uid: 0, gid: ADMIN_GID, mode: kind === "directory" ? 0o770 : 0o660 };
}

export function permits(
  attr: Attr,
  cred: Pick<Cred, "euid" | "gid">,
  want: number,
): boolean {
  if (cred.euid === 0) return true;
  const shift = cred.euid === attr.uid ? 6 : cred.gid === attr.gid ? 3 : 0;
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
