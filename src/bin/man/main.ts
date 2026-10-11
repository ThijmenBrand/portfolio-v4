// man — the manual. Pages are src/bin/man/pages/<command>.txt; `sh` is
// the shell's own help text, so the two can't drift apart.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { HELP } from "../sh/main";

const pages: Record<string, string> = {
  sh: `sh — the shell. Builtins, syntax and the commands that come with the system:\n\n${HELP}`,
  ...Object.fromEntries(
    Object.entries(
      import.meta.glob<string>("./pages/*.txt", { query: "?raw", import: "default", eager: true }),
    ).map(([path, text]) => [path.slice("./pages/".length, -".txt".length), text]),
  ),
};

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    const names = Object.keys(pages).sort();
    await print(os, 1, `man <command>. Pages:\n\n${columns(names)}\n`);
    return os.process.exit(0);
  }
  const page = pages[name];
  if (!page) {
    await print(os, 2, `No manual entry for ${name} (man lists them)\n`);
    return os.process.exit(1);
  }
  await print(os, 1, page);
  await os.process.exit(0);
}

function columns(names: string[]): string {
  const width = Math.max(...names.map((n) => n.length)) + 2;
  const perRow = 6;
  const rows: string[] = [];
  for (let i = 0; i < names.length; i += perRow) {
    rows.push("  " + names.slice(i, i + perRow).map((n) => n.padEnd(width)).join("").trimEnd());
  }
  return rows.join("\n");
}
