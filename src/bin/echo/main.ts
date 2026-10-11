// echo
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  await os.io.write(1, new TextEncoder().encode(`${args.join(" ")}\n`));
  await os.process.exit(0);
}
