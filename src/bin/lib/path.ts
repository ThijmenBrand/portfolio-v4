// PATH lookup for programs that run other programs (sudo, xargs, which).
import type { AppInterface } from "../../kernel/syscalls/api";
import type { SpawnOptions } from "../../kernel/syscalls/process";
import type { Pid } from "../../kernel/types";
import { errorCode } from "./input";

async function pathDirs(os: AppInterface): Promise<string[]> {
  return ((await os.process.env()).PATH ?? "").split(":").filter(Boolean);
}

/** Bare names are looked up on the caller's PATH, like sh does. */
export async function spawnOnPath(
  os: AppInterface,
  command: string,
  args: string[],
  options?: SpawnOptions,
): Promise<Pid> {
  if (command.includes("/")) return os.process.spawn(command, args, options);
  for (const dir of await pathDirs(os)) {
    try {
      return await os.process.spawn(`${dir}/${command}`, args, options);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) throw error;
    }
  }
  throw Object.assign(new Error(command), { code: "ENOENT" });
}

/** The file `command` would run, or null. */
export async function which(os: AppInterface, command: string): Promise<string | null> {
  const candidates = command.includes("/")
    ? [command]
    : (await pathDirs(os)).map((dir) => `${dir}/${command}`);
  for (const path of candidates) {
    const stat = await os.fs.stat(path).catch(() => null);
    if (stat?.kind === "file") return path;
  }
  return null;
}
