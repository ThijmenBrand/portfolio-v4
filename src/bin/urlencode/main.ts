// urlencode — percent-encode text (args, else stdin); -d decodes, -a keeps a whole URL intact.
import type { AppInterface } from "../../kernel/syscalls/api";
import { urlDecode, urlEncode } from "../lib/dev";
import { print, readFd } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const words = args.filter((a) => !a.startsWith("-"));
  // stdin: one trailing newline is the terminator, not part of the text.
  const text = words.length ? words.join(" ") : (await readFd(os, 0)).replace(/\n$/, "");
  if (!flags.includes("d")) {
    await print(os, 1, `${urlEncode(text, flags.includes("a"))}\n`);
    return os.process.exit(0);
  }
  const result = urlDecode(text);
  if (!result.ok) {
    await print(os, 2, `urlencode: ${result.error}\n`);
    return os.process.exit(1);
  }
  await print(os, 1, `${result.out}\n`);
  await os.process.exit(0);
}
