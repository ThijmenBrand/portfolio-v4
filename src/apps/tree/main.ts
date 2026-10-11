// tree — directory tree with box-drawing branches.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const root = args[0] ?? ".";
  const out: string[] = [root];
  let dirs = 0;
  let files = 0;

  async function walk(dir: string, indent: string): Promise<void> {
    const entries = (await os.fs.readdir(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const [i, entry] of entries.entries()) {
      const last = i === entries.length - 1;
      const isDir = entry.kind === "directory";
      out.push(`${indent}${last ? "└── " : "├── "}${entry.name}${isDir ? "/" : ""}`);
      if (isDir) {
        dirs++;
        await walk(`${dir.replace(/\/+$/, "")}/${entry.name}`, indent + (last ? "    " : "│   "));
      } else {
        files++;
      }
    }
  }

  try {
    await walk(root, "");
  } catch (error) {
    await print(os, 2, `tree: ${root}: ${errorCode(error)}\n`);
    return os.process.exit(1);
  }
  out.push("", `${dirs} directories, ${files} files`);
  await print(os, 1, `${out.join("\n")}\n`);
  await os.process.exit(0);
}
