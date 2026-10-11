import type { Termios } from "../../kernel/io/pty";
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";

const FLAGS = ["echo", "icanon", "isig"] as const;

export async function main(os: AppInterface, args: string[]): Promise<void> {
  try {
    if (args[0] === "size") {
      const { rows, cols } = await os.io.getWinsize(0);
      await print(os, 1, `${rows} ${cols}\n`);
      return os.process.exit(0);
    }

    const settings = args.filter((a) => a !== "-a");
    if (settings.length === 0) {
      const [termios, { rows, cols }] = await Promise.all([
        os.io.tcgetattr(0),
        os.io.getWinsize(0),
      ]);
      const flags = FLAGS.map((f) => (termios[f] ? f : `-${f}`)).join(" ");
      await print(os, 1, `rows ${rows}; columns ${cols};\n${flags}\n`);
      return os.process.exit(0);
    }

    const changes: Partial<Termios> = {};
    for (const setting of settings) {
      const flag = FLAGS.find((f) => f === setting.replace(/^-/, ""));
      if (!flag) {
        await print(os, 2, `stty: unknown setting: ${setting}\n`);
        return os.process.exit(1);
      }
      changes[flag] = !setting.startsWith("-");
    }
    await os.io.tcsetattr(0, changes);
  } catch (error) {
    await print(os, 2, `stty: stdin: ${errorCode(error)}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
