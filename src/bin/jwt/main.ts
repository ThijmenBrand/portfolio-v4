// jwt — decode a JSON Web Token's header and payload. Does not verify the signature.
import type { AppInterface } from "../../kernel/syscalls/api";
import { decodeJwt, relative } from "../lib/dev";
import { print, readFd } from "../lib/input";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const token = args[0] ?? (await readFd(os, 0));
  try {
    const jwt = decodeJwt(token);
    let out = `header:\n${JSON.stringify(jwt.header, null, 2)}\npayload:\n${JSON.stringify(jwt.payload, null, 2)}\n`;
    for (const [claim, date] of Object.entries(jwt.times))
      out += `${claim}: ${date.toISOString()} (${relative(date)})\n`;
    if (jwt.expired) out += "EXPIRED\n";
    await print(os, 1, out);
    await os.process.exit(0);
  } catch (error) {
    await print(os, 2, `jwt: ${(error as Error).message}\n`);
    await os.process.exit(1);
  }
}
