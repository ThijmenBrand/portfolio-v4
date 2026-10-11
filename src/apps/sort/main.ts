// sort — sort lines. -r reverse, -n numeric.
import type { AppInterface } from "../../kernel/syscalls/api";
import { joinLines, lines, print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const { text, ok } = await readInput(os, "sort", args.filter((a) => !a.startsWith("-")));

  const sorted = lines(text).sort(
    flags.includes("n")
      ? (a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0)
      : (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  if (flags.includes("r")) sorted.reverse();
  await print(os, 1, joinLines(sorted));
  await os.process.exit(ok ? 0 : 1);
}
