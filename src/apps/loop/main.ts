// echo
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await os.io.write(1, new TextEncoder().encode(`loop number ${i}\n`));
  }
  await os.process.exit(0);
}
