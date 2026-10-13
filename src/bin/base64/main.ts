// base64 — encode, or decode (-d); -u for the url-safe alphabet without padding.
import type { AppInterface } from "../../kernel/syscalls/api";
import { b64decode, b64encode } from "../lib/dev";
import { print, readInput } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const { text, ok } = await readInput(os, "base64", args.filter((a) => !a.startsWith("-")));
  if (!ok) return os.process.exit(1);
  if (!flags.includes("d")) {
    // Like coreutils: the input's trailing newline is encoded too (use echo -n).
    await print(os, 1, `${b64encode(text, flags.includes("u"))}\n`);
    return os.process.exit(0);
  }
  const result = b64decode(text);
  if (!result.ok) {
    await print(os, 2, `base64: ${result.error}\n`);
    return os.process.exit(1);
  }
  await print(os, 1, result.out);
  await os.process.exit(0);
}
