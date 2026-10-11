// mkdir — make directories. -p creates missing parents and ignores existing ones.
import type { AppInterface } from "../../kernel/syscalls/api";

const encoder = new TextEncoder();

function code(error: unknown): string {
  return (error as { code?: string }).code ?? "EIO";
}

export async function mkdirP(os: AppInterface, path: string): Promise<void> {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const prefix = (absolute ? "/" : "") + parts.slice(0, i).join("/");
    try {
      await os.fs.mkdir(prefix);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
  }
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const parents = args.includes("-p");
  const paths = args.filter((a) => !a.startsWith("-"));
  let status = 0;

  if (paths.length === 0) {
    await os.io.write(2, encoder.encode("usage: mkdir [-p] dir...\n"));
    status = 1;
  }

  for (const path of paths) {
    try {
      await (parents ? mkdirP(os, path) : os.fs.mkdir(path));
    } catch (error) {
      await os.io.write(2, encoder.encode(`mkdir: ${path}: ${code(error)}\n`));
      status = 1;
    }
  }
  await os.process.exit(status);
}
