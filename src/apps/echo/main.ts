// echo
import type { KernelInterface } from "../../kernel/syscalls/api";

export async function main(os: KernelInterface, args: string[]): Promise<void> {
  await os.io.write(1, new TextEncoder().encode(`${args.join(" ")}\n`));
  os.process.exit(0);
}
