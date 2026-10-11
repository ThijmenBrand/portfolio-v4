// rm — remove files. -r removes directories and everything in them.
import type { AppInterface } from "../../kernel/syscalls/api";

const encoder = new TextEncoder();

async function remove(os: AppInterface, path: string, recursive: boolean): Promise<void> {
  const stat = await os.fs.stat(path);
  if (stat.kind !== "directory") return os.fs.unlink(path);
  if (!recursive) throw Object.assign(new Error(), { code: "EISDIR" });

  for (const entry of await os.fs.readdir(path)) {
    await remove(os, `${path.replace(/\/+$/, "")}/${entry.name}`, true);
  }
  await os.fs.rmdir(path);
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const recursive = args.some((a) => /^-[a-z]*r/i.test(a));
  const paths = args.filter((a) => !a.startsWith("-"));
  let status = 0;

  if (paths.length === 0) {
    await os.io.write(2, encoder.encode("usage: rm [-r] path...\n"));
    status = 1;
  }

  for (const path of paths) {
    try {
      await remove(os, path, recursive);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "EIO";
      await os.io.write(2, encoder.encode(`rm: ${path}: ${code}\n`));
      status = 1;
    }
  }
  await os.process.exit(status);
}
