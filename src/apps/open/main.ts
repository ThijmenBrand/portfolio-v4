// open — open an https: or mailto: link in a new tab.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [url] = args;
  if (url === undefined) {
    await print(os, 2, "usage: open <https-url|mailto:address>\n");
    return os.process.exit(1);
  }
  try {
    await os.shell.openExternal(url.includes(":") ? url : `https://${url}`);
  } catch (error) {
    await print(os, 2, `open: ${error instanceof Error ? error.message : String(error)}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
