// ps — list processes.
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  const procs = await os.process.list();
  const lines = [
    "  PID  PPID  PGID  STATUS     COMMAND",
    ...procs.map(
      (p) =>
        `${String(p.pid).padStart(5)} ${String(p.parentPid).padStart(5)} ${String(p.pgid).padStart(5)}  ${String(p.status).padEnd(9)}  ${[p.path, ...p.args].join(" ")}`,
    ),
  ];
  await os.io.write(1, new TextEncoder().encode(`${lines.join("\n")}\n`));
  await os.process.exit(0);
}
