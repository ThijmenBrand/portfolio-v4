// cat — pure byte copy, so no decoding and no chunk-boundary hazard
import type { AppInterface } from "../../kernel/syscalls/api";

async function pump(os: AppInterface, fd: number): Promise<void> {
  for (;;) {
    const chunk = await os.io.read(fd, 4096);
    if (chunk.length === 0) return;
    await os.io.write(1, chunk);
  }
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  let status = 0;

  if (args.length === 0) {
    await pump(os, 0);
  } else {
    for (const path of args) {
      let fd: number;
      try {
        fd = await os.io.open(path, { read: true });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "EIO";
        await os.io.write(2, encoder.encode(`cat: ${path}: ${code}\n`));
        status = 1;
        continue;
      }
      try {
        await pump(os, fd);
      } finally {
        await os.io.close(fd);
      }
    }
  }
  await os.process.exit(status);
}
