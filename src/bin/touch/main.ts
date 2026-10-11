// touch — create empty files. Existing files keep their content.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  let status = 0;

  if (args.length === 0) {
    await os.io.write(2, encoder.encode("usage: touch file...\n"));
    status = 1;
  }

  for (const path of args) {
    try {
      await os.io.close(await os.io.open(path, { write: true, create: true }));
    } catch (error) {
      const code = (error as { code?: string }).code ?? "EIO";
      await os.io.write(2, encoder.encode(`touch: ${path}: ${code}\n`));
      status = 1;
    }
  }
  await os.process.exit(status);
}
