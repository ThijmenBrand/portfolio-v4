import type { AppInterface } from "../../kernel/syscalls/api";

/**
 * Tab completion for the terminal's input line.
 *
 * It lives here, not in sh, because the terminal owns line editing (no
 * kernel line discipline — sh only ever sees finished lines). Paths are
 * resolved against the SHELL's cwd, read from /proc/<pid>/cwd, not the
 * terminal's own.
 */

const BUILTINS = ["cd", "pwd", "exit", "help"];

/**
 * Programs on sh's search path. Executables only exist in the binfmt table,
 * not in the VFS, so they can't be listed with readdir yet.
 * TODO: derive this from readdir once /ProgramFiles is a real directory.
 */
const PROGRAMS = ["cat", "clear", "echo", "loop", "ls", "sh", "terminal"];

export interface Completion {
  value: string;
  cursor: number;
  /** Shown to the user when the word is ambiguous and could not be extended. */
  candidates: string[];
}

interface Word {
  start: number;
  text: string;
  /** First word of the line or of a pipeline stage: complete command names. */
  command: boolean;
}

interface Candidate {
  name: string;
  directory: boolean;
}

function wordAt(line: string, cursor: number): Word {
  let start = cursor;
  while (start > 0 && !/[\s|<>]/.test(line[start - 1])) start--;
  const before = line.slice(0, start).trimEnd();
  return {
    start,
    text: line.slice(start, cursor),
    command: before === "" || before.endsWith("|"),
  };
}

function commonPrefix(names: string[]): string {
  let prefix = names[0] ?? "";
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

async function pathCandidates(
  os: AppInterface,
  cwd: string,
  text: string,
): Promise<{ base: string; prefix: string; items: Candidate[] }> {
  const slash = text.lastIndexOf("/");
  const base = text.slice(0, slash + 1); // "src/" in "src/ma", "" in "ma"
  const prefix = text.slice(slash + 1);

  const dir = base.startsWith("/")
    ? base
    : base
      ? `${cwd === "/" ? "" : cwd}/${base}`
      : cwd;

  try {
    const entries = await os.fs.readdir(dir);
    return {
      base,
      prefix,
      items: entries
        .filter((e) => e.name.startsWith(prefix))
        .map((e) => ({ name: e.name, directory: e.kind === "directory" })),
    };
  } catch {
    return { base, prefix, items: [] }; // ENOENT/ENOTDIR: nothing to offer
  }
}

export async function complete(
  os: AppInterface,
  cwd: string,
  line: string,
  cursor: number,
): Promise<Completion> {
  const word = wordAt(line, cursor);

  const { base, prefix, items } =
    word.command && !word.text.includes("/")
      ? {
          base: "",
          prefix: word.text,
          items: [...BUILTINS, ...PROGRAMS]
            .filter((name) => name.startsWith(word.text))
            .map((name) => ({ name, directory: false })),
        }
      : await pathCandidates(os, cwd, word.text);

  const unchanged = { value: line, cursor, candidates: [] };
  if (items.length === 0) return unchanged;

  items.sort((a, b) => a.name.localeCompare(b.name));

  let replacement: string;
  let candidates: string[] = [];

  if (items.length === 1) {
    const [only] = items;
    // Directories end in "/" so the next Tab descends; everything else gets a space.
    // No extra space if the cursor already sits before one (completing mid-line).
    const spaced = /\s/.test(line[cursor] ?? "");
    replacement =
      base + only.name + (only.directory ? "/" : spaced ? "" : " ");
  } else {
    const shared = commonPrefix(items.map((i) => i.name));
    replacement = base + shared;
    if (shared.length === prefix.length) {
      // Can't extend the word: show the options instead.
      candidates = items.map((i) => i.name + (i.directory ? "/" : ""));
    }
  }

  const value = line.slice(0, word.start) + replacement + line.slice(cursor);
  return { value, cursor: word.start + replacement.length, candidates };
}
