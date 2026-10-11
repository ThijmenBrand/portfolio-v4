// ls — list directory contents. Runs as a worker: everything goes over the wire.
import type { DirEntry, NodeKind } from "../../kernel/fs/types";
import type { AppInterface } from "../../kernel/syscalls/api";
import { modeString, nameOf, readGroups, readUsers, type Group, type User } from "../lib/users";

const encoder = new TextEncoder();

/** ls -F style: "docs/" for directories, "fifo|" for pipes. */
function suffix(kind: NodeKind): string {
  if (kind === "directory") return "/";
  if (kind === "fifo") return "|";
  return "";
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** -l: mode, owner, group, size, modified, name. Columns padded to the widest. */
function longLines(entries: DirEntry[], users: User[], groups: Group[]): string[] {
  const rows = entries.map((e) => ({
    e,
    owner: nameOf(users, e.uid, "uid"),
    group: nameOf(groups, e.gid, "gid"),
  }));
  const widest = (pick: (r: (typeof rows)[number]) => string) =>
    Math.max(1, ...rows.map((r) => pick(r).length));
  const ownerW = widest((r) => r.owner);
  const groupW = widest((r) => r.group);
  const sizeW = widest((r) => String(r.e.size));
  return rows.map(({ e, owner, group }) => {
    const size = String(e.size).padStart(sizeW);
    return `${modeString(e.kind, e.mode)}  ${owner.padEnd(ownerW)}  ${group.padEnd(groupW)}  ${size}  ${formatDate(e.modifiedAt)}  ${e.name}${suffix(e.kind)}`;
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
  // Names for -l; numbers if the database is unreadable.
  const users = long ? await readUsers(os).catch(() => []) : [];
  const groups = long ? await readGroups(os).catch(() => []) : [];

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
      out.push(...(long ? longLines(entries, users, groups) : shortLines(entries)));
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
