// stat — file details.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let status = 0;
  if (args.length === 0) {
    await print(os, 2, "usage: stat path...\n");
    status = 1;
  }
  for (const path of args) {
    try {
      const s = await os.fs.stat(path);
      await print(
        os,
        1,
        [
          `  File: ${path}`,
          `  Type: ${s.kind}${s.readonly ? " (read-only)" : ""}`,
          `  Size: ${s.size}`,
          `Create: ${new Date(s.createdAt).toLocaleString()}`,
          `Modify: ${new Date(s.modifiedAt).toLocaleString()}`,
          "",
        ].join("\n"),
      );
    } catch (error) {
      await print(os, 2, `stat: ${path}: ${errorCode(error)}\n`);
      status = 1;
    }
  }
  await os.process.exit(status);
}
