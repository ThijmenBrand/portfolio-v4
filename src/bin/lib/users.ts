// The user database: /etc/passwd, /etc/group and /etc/shadow, plain text like
// Unix. The kernel only knows numbers; names live here.
import type { AppInterface } from "../../kernel/syscalls/api";

export interface User {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

const PASSWD = "/etc/passwd";
const GROUP = "/etc/group";
const SHADOW = "/etc/shadow";

/** Must match ADMIN_GID in src/kernel/fs/perm.ts. */
export const ADMIN_GID = 10;
const FIRST_UID = 1000;
const NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

const rows = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split(":"));

export async function readUsers(os: AppInterface): Promise<User[]> {
  return rows(await os.fs.readTextFile(PASSWD)).map(
    ([name = "", uid, gid, home = "", shell = ""]) => ({
      name,
      uid: Number(uid),
      gid: Number(gid),
      home,
      shell,
    }),
  );
}

export async function readGroups(os: AppInterface): Promise<Group[]> {
  return rows(await os.fs.readTextFile(GROUP)).map(
    ([name = "", gid, members = ""]) => ({
      name,
      gid: Number(gid),
      members: members.split(",").filter(Boolean),
    }),
  );
}

/** name -> `salt$hash`, "" (no password) or "!" (can't log in locally). Root only. */
export async function readShadow(os: AppInterface): Promise<Map<string, string>> {
  const text = await os.fs.readTextFile(SHADOW);
  return new Map(rows(text).map(([name = "", hash = "!"]) => [name, hash]));
}

export async function writeShadow(
  os: AppInterface,
  shadow: Map<string, string>,
): Promise<void> {
  const text = [...shadow].map(([name, hash]) => `${name}:${hash}\n`).join("");
  await os.fs.writeTextFile(SHADOW, text);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `salt$sha256(salt + password)`.
 * ponytail: a fast hash is fine here — the whole OS runs in the visitor's own
 * browser, so these passwords guard nothing real. The owner's password lives
 * on the backend (scrypt), never in this file.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${salt}$${await sha256(salt + password)}`;
}

export async function verifyPassword(entry: string, password: string): Promise<boolean> {
  if (entry === "") return true; // no password set
  const [salt, hash] = entry.split("$");
  if (!salt || !hash) return false; // "!" and anything malformed: locked
  return (await sha256(salt + password)) === hash;
}

export function userByName(users: User[], name: string): User | undefined {
  return users.find((user) => user.name === name);
}

/** The name for a uid, or the number itself when it has none (like ls). */
export function nameOf(list: Array<{ name: string; uid?: number; gid?: number }>, id: number, key: "uid" | "gid"): string {
  return list.find((entry) => entry[key] === id)?.name ?? String(id);
}

/** Environment for a login session: what login and su set. */
export function sessionEnv(user: User): Record<string, string> {
  return { USER: user.name, LOGNAME: user.name, HOME: user.home, SHELL: user.shell };
}

/**
 * Adds a user with the next free uid ≥ 1000, a locked password, and a home
 * only they can write. Needs root (writes /etc and chowns).
 */
export async function addUser(
  os: AppInterface,
  name: string,
  gid?: number,
): Promise<User> {
  if (!NAME.test(name)) throw new Error(`invalid user name: ${name}`);
  const users = await readUsers(os);
  if (userByName(users, name)) throw new Error(`user exists: ${name}`);

  const groups = await readGroups(os);
  // Skip gids too: the user's own group takes gid = uid.
  const uid = nextId(users, groups);
  const user: User = { name, uid, gid: gid ?? uid, home: `/home/${name}`, shell: "/ProgramFiles/sh" };

  await os.fs.writeTextFile(PASSWD, `${await os.fs.readTextFile(PASSWD)}${formatUser(user)}`);
  if (gid === undefined) {
    groups.push({ name, gid: uid, members: [] });
  } else {
    groups.find((group) => group.gid === gid)?.members.push(name);
  }
  await writeGroups(os, groups);
  const shadow = await readShadow(os);
  shadow.set(name, "!");
  await writeShadow(os, shadow);
  await makeHome(os, user, 0o755);
  return user;
}

const nextId = (users: User[], groups: Group[]) =>
  Math.max(FIRST_UID - 1, ...users.map((u) => u.uid), ...groups.map((g) => g.gid)) + 1;

/** Adds an empty group with the next free gid ≥ 1000. Needs root. */
export async function addGroup(os: AppInterface, name: string): Promise<Group> {
  if (!NAME.test(name)) throw new Error(`invalid group name: ${name}`);
  const groups = await readGroups(os);
  if (groups.some((group) => group.name === name)) throw new Error(`group exists: ${name}`);
  const group: Group = { name, gid: nextId(await readUsers(os), groups), members: [] };
  await writeGroups(os, [...groups, group]);
  return group;
}

/**
 * usermod: `-g` sets the primary group (what the kernel checks), `-aG` adds
 * to a member list (only sudo reads those). Needs root.
 */
export async function modifyUser(
  os: AppInterface,
  name: string,
  change: { primary?: string; append?: string[] },
): Promise<void> {
  const users = await readUsers(os);
  const groups = await readGroups(os);
  const user = userByName(users, name);
  if (!user) throw new Error(`no such user: ${name}`);
  const find = (g: string) => {
    const group = groups.find((entry) => entry.name === g);
    if (!group) throw new Error(`no such group: ${g}`);
    return group;
  };

  if (change.primary !== undefined) {
    user.gid = find(change.primary).gid;
    await os.fs.writeTextFile(PASSWD, users.map(formatUser).join(""));
  }
  if (change.append?.length) {
    for (const group of change.append.map(find)) {
      if (!group.members.includes(name)) group.members.push(name);
    }
    await writeGroups(os, groups);
  }
}

const formatUser = (u: User) => `${u.name}:${u.uid}:${u.gid}:${u.home}:${u.shell}\n`;

async function writeGroups(os: AppInterface, groups: Group[]): Promise<void> {
  await os.fs.writeTextFile(
    GROUP,
    groups.map((g) => `${g.name}:${g.gid}:${g.members.join(",")}\n`).join(""),
  );
}

async function makeHome(os: AppInterface, user: User, mode: number): Promise<void> {
  await os.fs.mkdir(user.home).catch((error) => {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  });
  await os.fs.chown(user.home, user.uid, user.gid);
  await os.fs.chmod(user.home, mode);
}

/**
 * First boot: root (password "root") and guest (no password). Shadow is
 * root-only; homes belong to their users. Runs as root (login).
 */
export async function seedUsers(os: AppInterface): Promise<void> {
  const exists = await os.fs.stat(PASSWD).then(() => true, () => false);
  if (exists) return;

  const root: User = { name: "root", uid: 0, gid: 0, home: "/home/root", shell: "/ProgramFiles/sh" };
  const guest: User = { name: "guest", uid: FIRST_UID, gid: FIRST_UID, home: "/home/guest", shell: "/ProgramFiles/sh" };

  await writeGroups(os, [
    { name: "root", gid: 0, members: [] },
    { name: "admin", gid: ADMIN_GID, members: [] },
    { name: "guest", gid: FIRST_UID, members: [] },
  ]);
  await writeShadow(os, new Map([["root", await hashPassword("root")], ["guest", ""]]));
  await os.fs.chmod(SHADOW, 0o600);
  await makeHome(os, root, 0o700);
  await makeHome(os, guest, 0o755);
  // Last: its presence means "seeded", so a crash halfway retries next boot.
  await os.fs.writeTextFile(PASSWD, formatUser(root) + formatUser(guest));
}

/** `drwxr-xr-x` */
export function modeString(kind: string, mode: number): string {
  const type = kind === "directory" ? "d" : kind === "fifo" ? "p" : "-";
  let bits = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const part = (mode >> shift) & 7;
    bits += (part & 4 ? "r" : "-") + (part & 2 ? "w" : "-") + (part & 1 ? "x" : "-");
  }
  return type + bits;
}
