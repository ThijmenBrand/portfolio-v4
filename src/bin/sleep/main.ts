// sleep — wait N seconds (fractions allowed). Ctrl-C ends it like any process.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const seconds = Number(args[0]);
  if (!Number.isFinite(seconds) || seconds < 0) {
    await print(os, 2, "usage: sleep seconds\n");
    return os.process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await os.process.exit(0);
}
