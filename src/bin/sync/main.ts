// sync — write out what the system still holds in memory (file owners and modes).
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  await os.system.sync();
  await os.process.exit(0);
}
