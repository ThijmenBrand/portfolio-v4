// wc — lines, words, bytes. -l / -w / -c pick columns.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const paths = args.filter((a) => !a.startsWith("-"));
  const { text, ok } = await readInput(os, "wc", paths);

  const counts = {
    l: (text.match(/\n/g) ?? []).length,
    w: text.split(/\s+/).filter(Boolean).length,
    c: new TextEncoder().encode(text).length,
  };
  const picked = (["l", "w", "c"] as const).filter((k) => !flags || flags.includes(k));
  await print(os, 1, `${picked.map((k) => String(counts[k]).padStart(7)).join(" ")}\n`);
  await os.process.exit(ok ? 0 : 1);
}
