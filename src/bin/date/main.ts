// date — current date and time.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  await os.io.write(1, new TextEncoder().encode(`${new Date().toString()}\n`));
  await os.process.exit(0);
}
