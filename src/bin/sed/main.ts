// sed — stream editor. sed [-n] [-i] script [file...]; see `man sed`.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, joinLines, lines, print, readInput } from "../lib/input";
import { compile, run } from "../lib/sed";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const quiet = args.includes("-n");
  const inPlace = args.includes("-i");
  const [script, ...files] = args.filter((a) => a !== "-n" && a !== "-i");
  if (script === undefined || (inPlace && files.length === 0)) {
    await print(os, 2, "usage: sed [-n] [-i] 's/re/rep/g; 2,5p; /re/d; $q' [file...]\n");
    return os.process.exit(1);
  }
  let cmds;
  try {
    cmds = compile(script);
  } catch (error) {
    await print(os, 2, `sed: ${(error as Error).message}\n`);
    return os.process.exit(1);
  }

  if (!inPlace) {
    const { text, ok } = await readInput(os, "sed", files);
    await print(os, 1, joinLines(run(cmds, lines(text), quiet)));
    return os.process.exit(ok ? 0 : 1);
  }

  let status = 0;
  for (const path of files) {
    try {
      const text = await os.fs.readTextFile(path);
      await os.fs.writeTextFile(path, joinLines(run(cmds, lines(text), quiet)));
    } catch (error) {
      await print(os, 2, `sed: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
