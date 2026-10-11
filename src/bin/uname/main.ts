// uname — system name. -a adds the browser it runs in.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const name = "PortfolioOS";
  const line = args.includes("-a") ? `${name} ${navigator.platform} ${navigator.userAgent}` : name;
  await os.io.write(1, new TextEncoder().encode(`${line}\n`));
  await os.process.exit(0);
}
