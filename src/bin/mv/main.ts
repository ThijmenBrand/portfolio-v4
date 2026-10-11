// mv — move or rename a file or directory. Where the kernel can't rename
// (EXDEV: across mounts, a directory on OPFS) it copies, then deletes.
import type { AppInterface } from "../../kernel/syscalls/api";
import { moveTree } from "../../utils/tree";
import { target } from "../cp/main";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  const [src, dst] = args;
  if (src === undefined || dst === undefined || args.length > 2) {
    await os.io.write(2, encoder.encode("usage: mv src dst\n"));
    return os.process.exit(1);
  }

  try {
    await moveTree(os, src, await target(os, src, dst));
  } catch (error) {
    const code = (error as { code?: string }).code ?? "EIO";
    await os.io.write(2, encoder.encode(`mv: ${src}: ${code}\n`));
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
