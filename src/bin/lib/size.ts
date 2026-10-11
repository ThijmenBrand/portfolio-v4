// Sizes for du and df.
import type { AppInterface } from "../../kernel/syscalls/api";

/** 1536 -> "1.5K". */
export function human(bytes: number): string {
  const units = ["", "K", "M", "G", "T"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) bytes /= 1024, i++;
  return i === 0 ? String(bytes) : `${bytes < 10 ? bytes.toFixed(1) : Math.round(bytes)}${units[i]}`;
}

/**
 * Total bytes under `path`. `report` is called for each directory after its
 * children, like du. Unreadable subdirectories count as 0. `skip` prunes paths.
 */
export async function sizeOf(
  os: AppInterface,
  path: string,
  report?: (dir: string, bytes: number) => Promise<void>,
  skip: (path: string) => boolean = () => false,
): Promise<number> {
  const stat = await os.fs.stat(path);
  if (stat.kind !== "directory") return stat.size;
  let total = 0;
  for (const entry of await os.fs.readdir(path).catch(() => [])) {
    const child = `${path.replace(/\/$/, "")}/${entry.name}`;
    if (skip(child)) continue;
    total += entry.kind === "directory" ? await sizeOf(os, child, report, skip) : entry.size;
  }
  await report?.(path, total);
  return total;
}
