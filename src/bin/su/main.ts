// su — run a shell as another user (root by default). setuid (binfmt.ts):
// it starts as root, so it can read /etc/shadow and start the shell as that
// user, but asks for their password unless whoever ran it is root already.
import type { AppInterface } from "../../kernel/syscalls/api";
import { askPassword, print } from "../lib/input";
import {
  readShadow,
  readUsers,
  sessionEnv,
  userByName,
  verifyPassword,
} from "../lib/users";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const name = args[0] ?? "root";
  const user = userByName(await readUsers(os), name);
  if (!user) {
    await print(os, 2, `su: unknown user: ${name}\n`);
    return os.process.exit(1);
  }

  const { uid } = await os.process.ids(); // real uid: who ran su
  if (uid !== 0) {
    const entry = (await readShadow(os)).get(name) ?? "!";
    const password = entry === "" ? "" : await askPassword(os, "Password: ");
    if (!(await verifyPassword(entry, password))) {
      await print(os, 2, "su: Authentication failure\n");
      return os.process.exit(1);
    }
  }

  const shell = await os.process.spawn(user.shell, [], {
    uid: user.uid,
    gid: user.gid,
    env: sessionEnv(user),
  });
  const termination = await os.process.wait(shell);
  await os.process.exit(termination.code);
}
