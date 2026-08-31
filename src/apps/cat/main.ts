// cat — pure byte copy, so no decoding and no chunk-boundary hazard
import type { KernelInterface } from "../../kernel/syscalls/api";

async function pump(os: KernelInterface, fd: number): Promise<void> {
  for (;;) {
    const chunk = await os.io.read(fd, 4096);
    if (chunk.length === 0) return;
    await os.io.write(1, chunk);
  }
}

export async function main(os: KernelInterface, args: string[]): Promise<void> {
  if (args.length === 0) {
    await pump(os, 0);
  } else {
    for (const path of args) {
      const fd = await os.io.open(path, { read: true });
      try {
        await pump(os, fd);
      } finally {
        await os.io.close(fd);
      }
    }
  }
  os.process.exit(0);
}
