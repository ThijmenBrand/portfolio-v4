// passwd — change a local password. setuid (binfmt.ts), so it can write
// /etc/shadow; only root may change someone else's.
import type { AppInterface } from "../../kernel/syscalls/api";
import { askPassword, print } from "../lib/input";
import {
  ADMIN_GID,
  hashPassword,
  nameOf,
  readShadow,
  readUsers,
  userByName,
  verifyPassword,
  writeShadow,
} from "../lib/users";

async function fail(os: AppInterface, message: string): Promise<void> {
  await print(os, 2, `passwd: ${message}\n`);
  await os.process.exit(1);
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const { uid } = await os.process.ids(); // real uid: who ran passwd
  const users = await readUsers(os);
  const name = args[0] ?? nameOf(users, uid, "uid");
  const user = userByName(users, name);

  if (!user) return fail(os, `unknown user: ${name}`);
  if (uid !== 0 && user.uid !== uid) return fail(os, "only root can change another user's password");
  if (user.gid === ADMIN_GID) return fail(os, "the owner's password lives on the backend");

  const shadow = await readShadow(os);
  if (uid !== 0) {
    const current = await askPassword(os, "Current password: ");
    if (!(await verifyPassword(shadow.get(name) ?? "!", current))) {
      return fail(os, "Authentication failure");
    }
  }
  const next = await askPassword(os, "New password: ");
  if ((await askPassword(os, "Retype new password: ")) !== next) {
    return fail(os, "passwords don't match");
  }

  // An empty password means none: log in without typing one.
  shadow.set(name, next === "" ? "" : await hashPassword(next));
  await writeShadow(os, shadow);
  await print(os, 1, `password updated for ${name}\n`);
  await os.process.exit(0);
}
