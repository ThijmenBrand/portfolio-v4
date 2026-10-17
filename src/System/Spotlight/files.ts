// Spotlight's file index: the files and folders under $HOME, by name. Walked
// when Spotlight is first opened and again only after something under home
// changed. Pure apart from the readdir it is given, so files.check.ts can
// run it in Node.

/** What the walk needs of a directory entry (fs/types.ts DirEntry). */
export interface Listed {
  name: string;
  kind: "file" | "directory" | "fifo";
}

export interface FileEntry {
  path: string;
  name: string;
  dir: boolean;
}

/** Past this many entries the walk stops: the shallowest are kept. */
export const MAX_FILES = 5000;
/** Folders deeper than this under home aren't looked into. */
const MAX_DEPTH = 12;

/**
 * Whether Spotlight lists it. Not dotfiles, nor anything in a dot-folder
 * (~/.config, installed apps in ~/.local), and not `.app` shortcuts or
 * `.app.js` bundles: those are apps, found as apps already.
 */
export function indexable(entry: Listed): boolean {
  if (entry.name.startsWith(".")) return false;
  if (entry.kind === "directory") return true;
  if (entry.kind !== "file") return false;
  return !entry.name.endsWith(".app") && !entry.name.endsWith(".app.js");
}

/** Whether a change at `path` can touch what the index under `home` holds. */
export function affects(home: string, path: string): boolean {
  const root = home.endsWith("/") ? home : `${home}/`;
  if (path !== home && !path.startsWith(root)) return false;
  return !path.slice(root.length).split("/").some((part) => part.startsWith("."));
}

/**
 * Everything indexable under `root`, a level at a time so the cap keeps the
 * shallow ones. A folder that can't be read is left out, not an error.
 */
export async function walk(
  readdir: (path: string) => Promise<readonly Listed[]>,
  root: string,
  limit = MAX_FILES,
): Promise<FileEntry[]> {
  const found: FileEntry[] = [];
  let level = [root];
  for (let depth = 0; level.length && depth <= MAX_DEPTH; depth++) {
    const listings = await Promise.all(level.map((dir) => readdir(dir).catch(() => [])));
    const next: string[] = [];
    for (const [i, entries] of listings.entries()) {
      const dir = level[i]!;
      const sorted = entries.filter(indexable).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (found.length >= limit) return found;
        const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        const isDir = entry.kind === "directory";
        found.push({ path, name: entry.name, dir: isDir });
        if (isDir) next.push(path);
      }
    }
    level = next;
  }
  return found;
}

/** Where it is, for showing: its folder, with home as "~". */
export function where(home: string, path: string): string {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}
