// ls — list directory contents. Runs as a worker: everything goes over the wire.
import type { DirEntry, NodeKind } from "../../kernel/fs/types";
import type { AppInterface } from "../../kernel/syscalls/api";

const encoder = new TextEncoder();

/** ls -F style: "docs/" for directories, "fifo|" for pipes. */
function suffix(kind: NodeKind): string {
  if (kind === "directory") return "/";
  if (kind === "fifo") return "|";
  return "";
}

function kindChar(kind: NodeKind): string {
  if (kind === "directory") return "d";
  if (kind === "fifo") return "p";
  return "-";
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** -l: kind + rw/ro, size, modified, name. Sizes right-aligned to the widest. */
function longLines(entries: DirEntry[]): string[] {
  const width = Math.max(1, ...entries.map((e) => String(e.size).length));
  return entries.map((e) => {
    const mode = `${kindChar(e.kind)}${e.readonly ? "r-" : "rw"}`;
    const size = String(e.size).padStart(width);
    return `${mode}  ${size}  ${formatDate(e.modifiedAt)}  ${e.name}${suffix(e.kind)}`;
  });
}

function shortLines(entries: DirEntry[]): string[] {
  return entries.map((e) => `${e.name}${suffix(e.kind)}`);
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const long = args.includes("-l");
  const paths = args.filter((a) => !a.startsWith("-"));
  if (paths.length === 0) paths.push(await os.process.cwd());

  const out: string[] = [];
  let status = 0;

  for (const [i, path] of paths.entries()) {
    try {
      const stat = await os.fs.stat(path);

      // `ls somefile` prints the file itself, like the real thing.
      const entries: DirEntry[] =
        stat.kind === "directory"
          ? await os.fs.readdir(path)
          : [{ name: path, ...stat }];

      entries.sort((a, b) => a.name.localeCompare(b.name));

      // Several directories: a header per directory, blank line between.
      if (paths.length > 1 && stat.kind === "directory") {
        if (i > 0) out.push("");
        out.push(`${path}:`);
      }
      out.push(...(long ? longLines(entries) : shortLines(entries)));
    } catch (error) {
      const code = (error as { code?: string }).code ?? "EIO";
      await os.io.write(2, encoder.encode(`ls: ${path}: ${code}\n`));
      status = 1;
    }
  }

  if (out.length > 0) {
    // One write instead of one per line: each write is a round trip over the wire.
    await os.io.write(1, encoder.encode(`${out.join("\n")}\n`));
  }
  await os.process.exit(status);
}
