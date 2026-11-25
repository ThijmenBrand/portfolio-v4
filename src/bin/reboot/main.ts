// reboot [--keep] | reboot --factory-reset --yes
// Log out and reload the page, starting the system again from scratch.
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { reboot, type RebootKind } from "../lib/reboot";

const USAGE = "usage: reboot [--keep]\n       reboot --factory-reset --yes\n";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const keep = args.includes("--keep") || args.includes("-k");
  const reset = args.includes("--factory-reset");
  const yes = args.includes("--yes");
  const known = args.every((a) => ["--keep", "-k", "--factory-reset", "--yes"].includes(a));
  if (!known || (keep && reset) || (reset && !yes) || (yes && !reset)) {
    await print(os, 2, USAGE);
    return os.process.exit(1);
  }
  const kind: RebootKind = reset ? "reset" : keep ? "keep" : "restart";
  try {
    await reboot(os, kind);
  } catch (error) {
    await print(os, 2, `reboot: ${(error as Error).message}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
