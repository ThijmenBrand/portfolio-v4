// uuid — random v4 UUIDs, or time-ordered v7 (-7); -n for how many.
import type { AppInterface } from "../../kernel/syscalls/api";
import { uuidV4, uuidV7 } from "../lib/dev";
import { countFlag, print } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const { n, rest } = countFlag(args, 1);
  const make = rest.includes("-7") ? uuidV7 : uuidV4;
  // ponytail: capped so a typo can't flood the terminal.
  const ids = Array.from({ length: Math.min(n, 10000) }, () => make());
  await print(os, 1, ids.length ? `${ids.join("\n")}\n` : "");
  await os.process.exit(0);
}
