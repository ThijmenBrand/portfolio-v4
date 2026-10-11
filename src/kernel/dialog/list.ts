import type { DirEntry } from "../fs/types";

/**
 * What an app asks for with `os.dialog.open`. Plain data: wire-safe.
 * "save" resolves to a path that may not exist yet; the app writes it.
 */
export interface DialogOptions {
  kind: "file" | "directory" | "save";
  title?: string;
  /** Folder to start in; relative paths resolve from the caller's cwd. */
  startIn?: string;
  /** "save" only: the suggested file name. */
  name?: string;
}

/** What the picker lists: no dot-files, folders first, files unless picking a folder. */
export function visibleEntries(
  entries: readonly DirEntry[],
  kind: DialogOptions["kind"],
): DirEntry[] {
  return entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        (e.kind === "directory" || (kind !== "directory" && e.kind === "file")),
    )
    .sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );
}

/** "/home/a" → [/, home, a], each with the path it leads to. */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const out = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at += `/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

// Self-check: node src/kernel/dialog/list.ts
if ((import.meta as { main?: boolean }).main) {
  const assert = (ok: boolean, what = "") => {
    if (!ok) throw new Error(`dialog list self-check failed: ${what}`);
  };
  const entry = (name: string, kind: DirEntry["kind"]) =>
    ({ name, kind }) as DirEntry;
  const raw = [
    entry("b.txt", "file"),
    entry("Zeta", "directory"),
    entry(".git", "directory"),
    entry("alpha", "directory"),
    entry("pipe", "fifo"),
  ];
  const names = (kind: DialogOptions["kind"]) =>
    visibleEntries(raw, kind).map((e) => e.name).join(",");
  assert(names("directory") === "alpha,Zeta", names("directory"));
  assert(names("file") === "alpha,Zeta,b.txt", names("file"));
  assert(names("save") === "alpha,Zeta,b.txt", names("save"));
  assert(crumbs("/").length === 1, "root");
  const c = crumbs("/home/a");
  assert(c.map((x) => x.path).join(",") === "/,/home,/home/a", "crumb paths");
  assert(c[2].name === "a", "crumb name");
  console.log("dialog list: ok");
}
