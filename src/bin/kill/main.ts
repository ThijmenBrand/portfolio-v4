// kill — send a signal (default SIGTERM). `kill -INT 4`, `kill -SIGSTOP 4`,
// and a negative pid signals a whole process group: `kill -CONT -12`.
import type { Signal } from "../../kernel/proc/signals";
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid } from "../../kernel/types";

// Type-only import above: the runtime signals module pulls in kernel internals.
const SIGNALS: Signal[] = [
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGINT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGCONT",
  "SIGWINCH",
];

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const encoder = new TextEncoder();
  const flag = /^-[A-Za-z]/.test(args[0] ?? "") ? args[0] : undefined;
  const pids = flag ? args.slice(1) : args;

  const name = flag
    ? flag
        .slice(1)
        .toUpperCase()
        .replace(/^(SIG)?/, "SIG")
    : "SIGTERM";
  const signal = SIGNALS.find((s) => s === name);
  if (!signal || pids.length === 0 || pids.some((p) => !/^-?\d+$/.test(p))) {
    const known = SIGNALS.join(" ");
    await os.io.write(
      2,
      encoder.encode(`usage: kill [-SIGNAL] pid|-pgid...\nsignals: ${known}\n`),
    );
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
