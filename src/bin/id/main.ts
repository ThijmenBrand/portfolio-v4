// id — real and effective user and group ids, with names.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { nameOf, readGroups, readUsers } from "../lib/users";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  const { uid, euid, gid } = await os.process.ids();
  const users = await readUsers(os).catch(() => []);
  const groups = await readGroups(os).catch(() => []);
  const user = (id: number) => `${id}(${nameOf(users, id, "uid")})`;

  let line = `uid=${user(uid)} gid=${gid}(${nameOf(groups, gid, "gid")})`;
  if (euid !== uid) line += ` euid=${user(euid)}`;
  await print(os, 1, `${line}\n`);
  await os.process.exit(0);
}
