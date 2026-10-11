// cp — copy a file. A directory destination keeps the source's name.
import { basename } from "../../kernel/fs/path";
import type { AppInterface } from "../../kernel/syscalls/api";

/** "dir" -> "dir/name" when dst is an existing directory, else dst as given. */
export async function target(os: AppInterface, src: string, dst: string): Promise<string> {
  try {
    if ((await os.fs.stat(dst)).kind === "directory") {
      return `${dst.replace(/\/+$/, "")}/${basename(src)}`;
    }
  } catch {
    // ENOENT: a new file, written as given
  }
  return dst;
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  const [src, dst] = args;
  if (src === undefined || dst === undefined || args.length > 2) {
    await os.io.write(2, encoder.encode("usage: cp src dst\n"));
    return os.process.exit(1);
  }

  try {
    await os.fs.writeFile(await target(os, src, dst), await os.fs.readFile(src));
  } catch (error) {
    const code = (error as { code?: string }).code ?? "EIO";
    await os.io.write(2, encoder.encode(`cp: ${src}: ${code}\n`));
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
