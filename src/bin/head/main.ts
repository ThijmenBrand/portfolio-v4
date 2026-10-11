// head — first N lines (default 10).
import type { AppInterface } from "../../kernel/syscalls/api";
import { countFlag, joinLines, lines, print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const { n, rest } = countFlag(args, 10);
  const { text, ok } = await readInput(os, "head", rest);
  await print(os, 1, joinLines(lines(text).slice(0, n)));
  await os.process.exit(ok ? 0 : 1);
}
