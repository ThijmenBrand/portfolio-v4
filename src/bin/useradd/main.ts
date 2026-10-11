// useradd — add a local user with a home directory. Root only: use `su` first.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { addUser } from "../lib/users";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [name] = args;
  if (!name || args.length > 1) {
    await print(os, 2, "usage: useradd name\n");
    return os.process.exit(1);
  }
  if ((await os.process.ids()).euid !== 0) {
    await print(os, 2, "useradd: permission denied (try `su` first)\n");
    return os.process.exit(1);
  }

  try {
    const user = await addUser(os, name);
    await print(os, 1, `added ${user.name} (uid ${user.uid}); set a password with \`passwd ${user.name}\`\n`);
  } catch (error) {
    await print(os, 2, `useradd: ${(error as Error).message}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
