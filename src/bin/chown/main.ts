// chown — give files to another user (and group). Root only, like Unix.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";
import { readGroups, readUsers } from "../lib/users";

/** A name from the list, or a plain number. */
function lookup(list: Array<{ name: string }>, key: "uid" | "gid", value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const entry = list.find((e) => e.name === value) as Record<string, unknown> | undefined;
  return entry ? (entry[key] as number) : undefined;
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [owner, ...paths] = args;
  if (!owner || paths.length === 0) {
    await print(os, 2, "usage: chown user[:group] path...\n");
    return os.process.exit(1);
  }

  const users = await readUsers(os);
  const [userName = "", groupName] = owner.split(":");
  const uid = lookup(users, "uid", userName);
  const user = users.find((u) => u.uid === uid);
  const gid = groupName ? lookup(await readGroups(os), "gid", groupName) : user?.gid;
  if (uid === undefined || gid === undefined) {
    await print(os, 2, `chown: unknown user or group: ${owner}\n`);
    return os.process.exit(1);
  }

  let status = 0;
  for (const path of paths) {
    try {
      await os.fs.chown(path, uid, gid);
    } catch (error) {
      await print(os, 2, `chown: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
