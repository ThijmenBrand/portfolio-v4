// df — usage per mount, from /proc/mounts. -h human sizes.
// mem mounts live in RAM and have no fixed size; opfs mounts share the
// browser's storage quota (navigator.storage.estimate()).
import type { AppInterface } from "../../kernel/syscalls/api";
import { print } from "../lib/input";
import { human, sizeOf } from "../lib/size";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const fmt = args.includes("-h") ? human : String;
  const mounts = (await os.fs.readTextFile("/proc/mounts"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type = "", path = "", mode = ""] = line.split(" ");
      return { type, path, mode };
    });
  const quota = await navigator.storage?.estimate?.().catch(() => undefined);

  const rows = [["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"]];
  for (const { type, path, mode } of mounts) {
    // Each mount counts only its own files, not mounts below it.
    const others = mounts.filter((m) => m.path !== path).map((m) => m.path);
    const used = type === "proc" ? 0 : await sizeOf(os, path, undefined, (p) => others.includes(p)).catch(() => 0);
    const size = type === "opfs" ? quota?.quota : undefined;
    const avail = size !== undefined ? size - (quota?.usage ?? 0) : undefined;
    rows.push([
      `${type}${mode === "ro" ? " (ro)" : ""}`,
      size !== undefined ? fmt(size) : "-",
      fmt(used),
      avail !== undefined ? fmt(avail) : "-",
      size ? `${Math.ceil((100 * (quota?.usage ?? 0)) / size)}%` : "-",
      path,
    ]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  await print(os, 1, rows.map((r) => r.map((cell, c) => (c === 5 ? cell : cell.padEnd(widths[c]!))).join("  ")).join("\n") + "\n");
  await os.process.exit(0);
}
