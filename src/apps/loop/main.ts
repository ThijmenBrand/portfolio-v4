// echo
import type { KernelInterface } from "../../kernel/syscalls/api";

export async function main(
  os: KernelInterface,
  _args: string[],
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await os.io.write(1, new TextEncoder().encode(`loop number ${i}\n`));
  }
  os.process.exit(0);
}
