// whoami — the name of the effective user.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { nameOf, readUsers } from "../lib/users";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  const { euid } = await os.process.ids();
  const users = await readUsers(os).catch(() => []);
  await print(os, 1, `${nameOf(users, euid, "uid")}\n`);
  await os.process.exit(0);
}
