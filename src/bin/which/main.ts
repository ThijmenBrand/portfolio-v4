// which — where a command comes from: a sh builtin or a file on PATH.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { which } from "../lib/path";
import { BUILTINS } from "../sh/main";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  if (args.length === 0) {
    await print(os, 2, "usage: which command...\n");
    return os.process.exit(1);
  }
  let status = 0;
  for (const name of args) {
    const path = BUILTINS.has(name) ? `${name}: shell builtin` : await which(os, name);
    if (path) await print(os, 1, `${path}\n`);
    else {
      await print(os, 2, `which: no ${name} in PATH\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
