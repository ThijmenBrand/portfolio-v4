// usermod — change a user's groups. Root only: use `su` first.
//   usermod -g group user        set the primary group (used for file access)
//   usermod -aG g1,g2 user       add to groups' member lists (admin → sudo)
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { modifyUser } from "../lib/users";

const USAGE = "usage: usermod [-g group] [-aG group[,group...]] user\n";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let primary: string | undefined;
  let append: string[] | undefined;
  const rest = [...args];
  while (rest.length > 1) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === "-g" && value) primary = value;
    else if (flag === "-aG" && value) append = value.split(",").filter(Boolean);
    else {
      await print(os, 2, USAGE);
      return os.process.exit(1);
    }
  }
  const [name] = rest;
  if (!name || (primary === undefined && !append?.length)) {
    await print(os, 2, USAGE);
    return os.process.exit(1);
  }
  if ((await os.process.ids()).euid !== 0) {
    await print(os, 2, "usermod: permission denied (try `su` first)\n");
    return os.process.exit(1);
  }

  try {
    await modifyUser(os, name, { primary, append });
  } catch (error) {
    await print(os, 2, `usermod: ${(error as Error).message}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
