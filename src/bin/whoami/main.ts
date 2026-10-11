// whoami — ponytail: there are no users, everyone is the visitor.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  await os.io.write(1, new TextEncoder().encode("guest\n"));
  await os.process.exit(0);
}
