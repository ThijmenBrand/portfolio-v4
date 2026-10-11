// diff — compare two files line by line. -u for unified output.
// Exit 0: same, 1: different, 2: trouble.
import type { AppInterface } from "../../kernel/syscalls/api";
import { diffLines, normal, unified } from "../lib/diff";
import { errorCode, lines, print, readFd } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const u = args.includes("-u");
  const files = args.filter((a) => a !== "-u");
  if (files.length !== 2) {
    await print(os, 2, "usage: diff [-u] file1 file2   (- reads stdin)\n");
    return os.process.exit(2);
  }
  const texts: string[] = [];
  for (const path of files) {
    try {
      texts.push(path === "-" ? await readFd(os, 0) : await os.fs.readTextFile(path));
    } catch (error) {
      await print(os, 2, `diff: ${path}: ${errorCode(error)}\n`);
      return os.process.exit(2);
    }
  }
  const ops = diffLines(lines(texts[0]!), lines(texts[1]!));
  let body = u ? unified(ops) : normal(ops);
  if (body && u) body = `--- ${files[0]}\n+++ ${files[1]}\n${body}`;
  await print(os, 1, body);
  await os.process.exit(body ? 1 : 0);
}

