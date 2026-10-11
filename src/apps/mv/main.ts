// mv — move a file. ponytail: no rename syscall, so copy + unlink; files only.
import type { AppInterface } from "../../kernel/syscalls/api";
import { target } from "../cp/main";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  const [src, dst] = args;
  if (src === undefined || dst === undefined || args.length > 2) {
    await os.io.write(2, encoder.encode("usage: mv src dst\n"));
    return os.process.exit(1);
  }

  try {
    const data = await os.fs.readFile(src); // EISDIR for directories
    await os.fs.writeFile(await target(os, src, dst), data);
    await os.fs.unlink(src);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "EIO";
    await os.io.write(2, encoder.encode(`mv: ${src}: ${code}\n`));
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
