// kill — send a signal (default SIGTERM). `kill -INT 4` or `kill -SIGINT 4`.
import type { Signal } from "../../kernel/proc/signals";
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid } from "../../kernel/types";

// Type-only import above: the runtime signals module pulls in kernel internals.
const SIGNALS: Signal[] = ["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT"];

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  const flag = args.find((a) => a.startsWith("-"));
  const pids = args.filter((a) => !a.startsWith("-"));

  const name = flag ? flag.slice(1).toUpperCase().replace(/^(SIG)?/, "SIG") : "SIGTERM";
  const signal = SIGNALS.find((s) => s === name);
  if (!signal || pids.length === 0) {
    const known = SIGNALS.join(" ");
    await os.io.write(2, encoder.encode(`usage: kill [-SIGNAL] pid...\nsignals: ${known}\n`));
    return os.process.exit(1);
  }

  let status = 0;
  for (const pid of pids) {
    try {
      await os.process.kill(Number(pid) as Pid, signal);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "EIO";
      await os.io.write(2, encoder.encode(`kill: ${pid}: ${code}\n`));
      status = 1;
    }
  }
  await os.process.exit(status);
}
