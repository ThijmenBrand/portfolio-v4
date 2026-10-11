// tee — copy stdin to stdout and to files. -a appends.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const append = args.includes("-a");
  const fds: number[] = [];
  let status = 0;

  for (const path of args.filter((a) => !a.startsWith("-"))) {
    try {
      fds.push(await os.io.open(path, { write: true, create: true, truncate: !append, append }));
    } catch (error) {
      await print(os, 2, `tee: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }

  try {
    for (;;) {
      const chunk = await os.io.read(0, 4096);
      if (chunk.length === 0) break;
      await os.io.write(1, chunk);
      for (const fd of fds) await os.io.write(fd, chunk);
    }
  } finally {
    for (const fd of fds) await os.io.close(fd).catch(() => {});
  }
  await os.process.exit(status);
}
