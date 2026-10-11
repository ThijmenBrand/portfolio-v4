// grep — print matching lines. -i ignore case, -v invert, -n line numbers.
// Exit 0 if anything matched, 1 if not, 2 on error (like the real one).
import type { AppInterface } from "../../kernel/syscalls/api";
import { joinLines, lines, print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const flags = args.filter((a) => /^-[a-z]+$/.test(a)).join("");
  const [pattern, ...paths] = args.filter((a) => !/^-[a-z]+$/.test(a));
  if (pattern === undefined) {
    await print(os, 2, "usage: grep [-i] [-v] [-n] pattern [file...]\n");
    return os.process.exit(2);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags.includes("i") ? "i" : "");
  } catch {
    await print(os, 2, `grep: bad pattern: ${pattern}\n`);
    return os.process.exit(2);
  }

  const { text, ok } = await readInput(os, "grep", paths);
  const invert = flags.includes("v");
  const matches = lines(text)
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => regex.test(line) !== invert)
    .map(({ line, i }) => (flags.includes("n") ? `${i + 1}:${line}` : line));

  await print(os, 1, joinLines(matches));
  await os.process.exit(!ok ? 2 : matches.length ? 0 : 1);
}
