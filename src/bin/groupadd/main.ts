// groupadd — add an empty group. Root only: use `su` first.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { addGroup } from "../lib/users";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [name] = args;
  if (!name || args.length > 1) {
    await print(os, 2, "usage: groupadd name\n");
    return os.process.exit(1);
  }
  if ((await os.process.ids()).euid !== 0) {
    await print(os, 2, "groupadd: permission denied (try `su` first)\n");
    return os.process.exit(1);
  }

  try {
    const group = await addGroup(os, name);
    await print(os, 1, `added group ${group.name} (gid ${group.gid})\n`);
  } catch (error) {
    await print(os, 2, `groupadd: ${(error as Error).message}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
