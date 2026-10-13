// json — pretty-print or minify (-m) JSON; invalid input exits 1 with line:col.
import type { AppInterface } from "../../kernel/syscalls/api";
import { formatJson } from "../lib/dev";
import { print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let indent = 2;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m") indent = 0;
    else if (args[i] === "-i") indent = Number(args[++i]);
    else paths.push(args[i]!);
  }
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) {
    await print(os, 2, "json: -i takes 0-10\n");
    return os.process.exit(2);
  }
  const { text, ok } = await readInput(os, "json", paths);
  if (!ok) return os.process.exit(1);
  const result = formatJson(text, indent);
  if (!result.ok) {
    await print(os, 2, `json: ${result.error}\n`);
    return os.process.exit(1);
  }
  await print(os, 1, `${result.out}\n`);
  await os.process.exit(0);
}
