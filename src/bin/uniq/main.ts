// uniq — drop adjacent duplicate lines. -c prefixes counts.
import type { AppInterface } from "../../kernel/syscalls/api";
import { joinLines, lines, print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const count = args.includes("-c");
  const { text, ok } = await readInput(os, "uniq", args.filter((a) => !a.startsWith("-")));

  const runs: Array<{ line: string; n: number }> = [];
  for (const line of lines(text)) {
    const last = runs[runs.length - 1];
    if (last && last.line === line) last.n++;
    else runs.push({ line, n: 1 });
  }
  await print(os, 1, joinLines(runs.map((r) => (count ? `${String(r.n).padStart(7)} ${r.line}` : r.line))));
  await os.process.exit(ok ? 0 : 1);
}
