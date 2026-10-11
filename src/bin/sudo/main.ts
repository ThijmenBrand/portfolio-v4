// sudo — run one command as root. setuid (binfmt.ts), like su, but only for
// the admin group, and it asks for *your* password, not root's. The owner's
// password lives on the backend, so that one is checked there (like Login).
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid } from "../../kernel/types";
import { askPassword, errorCode, print } from "../lib/input";
import {
  ADMIN_GID,
  nameOf,
  readGroups,
  readShadow,
  readUsers,
  verifyPassword,
} from "../lib/users";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command) {
    await print(os, 2, "usage: sudo command [args...]\n");
    return os.process.exit(1);
  }

  const { uid, gid } = await os.process.ids(); // real ids: who ran sudo
  const name = nameOf(await readUsers(os), uid, "uid");
  if (uid !== 0) {
    const admins = (await readGroups(os)).find(
      (group) => group.gid === ADMIN_GID,
    );
    if (gid !== ADMIN_GID && !admins?.members.includes(name)) {
      await print(os, 2, `${name} is not in the sudoers file.\n`);
      return os.process.exit(1);
    }
    const password = await askPassword(os, `[sudo] password for ${name}: `);
    if (!(await verify(os, name, gid, password))) {
      await print(os, 2, "sudo: Authentication failure\n");
      return os.process.exit(1);
    }
  }

  const env = { USER: "root", LOGNAME: "root", SUDO_USER: name };
  let pid: Pid;
  try {
    pid = await spawn(os, command, rest, env);
  } catch (error) {
    const code = errorCode(error);
    await print(
      os,
      2,
      `sudo: ${command}: ${code === "ENOENT" ? "command not found" : code}\n`,
    );
    return os.process.exit(1);
  }
  await os.process.onSignal("SIGINT", () => {});
  const termination = await os.process.wait(pid);
  await os.process.exit(termination.code);
}

async function verify(
  os: AppInterface,
  name: string,
  gid: number,
  password: string,
): Promise<boolean> {
  if (gid !== ADMIN_GID) {
    return verifyPassword((await readShadow(os)).get(name) ?? "!", password);
  }
  const response = await os.api
    .fetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: name, password }),
    })
    .catch(() => ({ status: 0 }));
  return response.status === 204;
}

/** Bare names are looked up on the caller's PATH, like sh does. */
async function spawn(
  os: AppInterface,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<Pid> {
  const options = { uid: 0, gid: 0, env };
  if (command.includes("/")) return os.process.spawn(command, args, options);
  for (const dir of ((await os.process.env()).PATH ?? "")
    .split(":")
    .filter(Boolean)) {
    try {
      return await os.process.spawn(`${dir}/${command}`, args, options);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) throw error;
    }
  }
  throw Object.assign(new Error(command), { code: "ENOENT" });
}
