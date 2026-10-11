// find — list paths under a directory. -name takes a glob (* and ?).
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

function globToRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const nameAt = args.indexOf("-name");
  const pattern = nameAt >= 0 ? args[nameAt + 1] : undefined;
  if (nameAt >= 0 && pattern === undefined) {
    await print(os, 2, "usage: find [dir] [-name glob]\n");
    return os.process.exit(1);
  }
  const match = pattern === undefined ? () => true : (n: string) => globToRegex(pattern).test(n);
  const root = (nameAt === 0 ? undefined : args[0]) ?? ".";

  const out: string[] = [];
  if (match(root.split("/").pop() ?? root)) out.push(root);

  async function walk(dir: string): Promise<void> {
    for (const entry of await os.fs.readdir(dir)) {
      const path = `${dir.replace(/\/+$/, "")}/${entry.name}`;
      if (match(entry.name)) out.push(path);
      if (entry.kind === "directory") await walk(path);
    }
  }

  try {
    if ((await os.fs.stat(root)).kind === "directory") await walk(root);
  } catch (error) {
    await print(os, 2, `find: ${root}: ${errorCode(error)}\n`);
    return os.process.exit(1);
  }
  await print(os, 1, out.length ? `${out.join("\n")}\n` : "");
  await os.process.exit(0);
}
