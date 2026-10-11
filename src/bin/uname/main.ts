// uname — system name. -a adds the browser it runs in.
import type { AppInterface } from "../../kernel/syscalls/api";
import { OS_NAME } from "../../kernel/version";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const line = args.includes("-a") ? `${OS_NAME} ${navigator.platform} ${navigator.userAgent}` : OS_NAME;
  await os.io.write(1, new TextEncoder().encode(`${line}\n`));
  await os.process.exit(0);
}
