// stat — file details.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";
import { modeString, nameOf, readGroups, readUsers } from "../lib/users";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let status = 0;
  if (args.length === 0) {
    await print(os, 2, "usage: stat path...\n");
    status = 1;
  }
  const users = await readUsers(os).catch(() => []);
  const groups = await readGroups(os).catch(() => []);
  for (const path of args) {
    try {
      const s = await os.fs.stat(path);
      const octal = s.mode.toString(8).padStart(4, "0");
      await print(
        os,
        1,
        [
          `  File: ${path}`,
          `  Type: ${s.kind}${s.readonly ? " (read-only)" : ""}`,
          `  Size: ${s.size}`,
          `Access: ${octal} ${modeString(s.kind, s.mode)}`,
          ` Owner: ${nameOf(users, s.uid, "uid")} (${s.uid})  Group: ${nameOf(groups, s.gid, "gid")} (${s.gid})`,
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
