// df — usage per mount, from /proc/mounts. -h human sizes.
// mem mounts live in RAM and have no fixed size; opfs mounts share the
// browser's storage quota (navigator.storage.estimate()); a remote mount is
// on the server, which keeps its own count and reports it in one call --
// walking that one would mean an HTTP request per file.
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
    let used = 0;
    let size: number | undefined;
    let taken: number | undefined; // what Use% is a percentage of

    if (type === "remote") {
      // One call; the server already knows. Anyone it won't answer (a guest,
      // or nobody signed in) simply sees zeroes.
      const usage = await cloudUsage(os);
      used = usage?.bytes ?? 0;
      size = usage?.maxBytes;
      taken = used;
    } else if (type !== "proc") {
      // Each mount counts only its own files, not mounts below it.
      const others = mounts.filter((m) => m.path !== path).map((m) => m.path);
      used = await sizeOf(os, path, undefined, (p) => others.includes(p)).catch(() => 0);
      size = type === "opfs" ? quota?.quota : undefined;
      taken = quota?.usage ?? 0;
    }
    const avail = size !== undefined ? size - (taken ?? 0) : undefined;
    rows.push([
      `${type}${mode === "ro" ? " (ro)" : ""}`,
      size !== undefined ? fmt(size) : "-",
      fmt(used),
      avail !== undefined ? fmt(avail) : "-",
      size ? `${Math.ceil((100 * (taken ?? 0)) / size)}%` : "-",
      path,
    ]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  await print(os, 1, rows.map((r) => r.map((cell, c) => (c === 5 ? cell : cell.padEnd(widths[c]!))).join("  ")).join("\n") + "\n");
  await os.process.exit(0);
}

/** The server's own tally for the cloud mount, or nothing if it won't say. */
async function cloudUsage(
  os: AppInterface,
): Promise<{ bytes: number; maxBytes: number } | undefined> {
  try {
    const response = await os.api.fetch("/api/private/fs/usage");
    if (response.status !== 200) return undefined;
    return JSON.parse(response.body) as { bytes: number; maxBytes: number };
  } catch {
    return undefined; // not signed in, not allowed, or offline
  }
}
