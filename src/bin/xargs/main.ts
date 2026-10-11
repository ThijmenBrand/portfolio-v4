// xargs — run a command with arguments read from stdin.
// xargs [-n N] [-I {}] command [args...]   (default command: echo)
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print, readFd } from "../lib/input";
import { spawnOnPath } from "../lib/path";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  let max = Infinity;
  let replace: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n") max = Number(args[++i]);
    else if (a.startsWith("-n")) max = Number(a.slice(2));
    else if (a === "-I") replace = args[++i];
    else if (a.startsWith("-I")) replace = a.slice(2);
    else break;
  }
  const [command = "echo", ...fixed] = args.slice(i);
  if (!(max >= 1) || replace === "") {
    await print(os, 2, "usage: xargs [-n N] [-I {}] command [args...]\n");
    return os.process.exit(1);
  }

  const input = await readFd(os, 0);
  // -I: one run per line, {} replaced. Otherwise whitespace-split, -n per run.
  const items = replace ? input.split("\n").filter(Boolean) : input.split(/\s+/).filter(Boolean);
  const batches: string[][] = [];
  if (replace) for (const item of items) batches.push(fixed.map((a) => a.replaceAll(replace!, item)));
  else for (let k = 0; k < items.length || k === 0; k += max) batches.push([...fixed, ...items.slice(k, k + max)]);

  // The child must not read the stdin we already drained: give it an empty pipe.
  const { read, write } = await os.io.pipe();
  await os.io.close(write);
  let status = 0;
  try {
    for (const batch of batches) {
      let pid;
      try {
        pid = await spawnOnPath(os, command, batch, { fds: { 0: read, 1: 1, 2: 2 } });
      } catch (error) {
        const code = errorCode(error);
        await print(os, 2, `xargs: ${command}: ${code === "ENOENT" ? "command not found" : code}\n`);
        return os.process.exit(127);
      }
      if ((await os.process.wait(pid)).code !== 0) status = 123;
    }
  } finally {
    await os.io.close(read).catch(() => {});
  }
  await os.process.exit(status);
}
