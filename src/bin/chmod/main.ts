// chmod — set a mode. Octal only (chmod 640 file); ponytail: no u+x symbolic
// modes, add them if anyone misses them.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [mode, ...paths] = args;
  if (!mode || !/^[0-7]{3}$/.test(mode) || paths.length === 0) {
    await print(os, 2, "usage: chmod <octal mode, e.g. 644> path...\n");
    return os.process.exit(1);
  }

  let status = 0;
  for (const path of paths) {
    try {
      await os.fs.chmod(path, parseInt(mode, 8));
    } catch (error) {
      await print(os, 2, `chmod: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
