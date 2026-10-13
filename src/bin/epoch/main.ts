// epoch — a time in every format: unix seconds/ms, ISO, local, relative.
import type { AppInterface } from "../../kernel/syscalls/api";
import { parseTime, timeRows } from "../lib/dev";
import { print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  try {
    const rows = timeRows(parseTime(args.join(" ")));
    await print(os, 1, rows.map(([k, v]) => `${k.padEnd(9)}${v}\n`).join(""));
    await os.process.exit(0);
  } catch (error) {
    await print(os, 2, `epoch: ${(error as Error).message}\n`);
    await os.process.exit(1);
  }
}
