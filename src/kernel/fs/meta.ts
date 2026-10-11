import type { Attr } from "./perm";

/**
 * Persistence for what OPFS can't store itself: owners and modes, kept as
 * one JSON file in the OPFS root. Every mount serves a subdirectory
 * ("home", "etc"), so this file is outside all of them and no process can
 * read or edit it.
 */
const META = "meta.json";

/** Saved attributes, keyed by absolute VFS path. Missing or broken: none. */
export async function loadMeta(): Promise<Record<string, Attr>> {
  try {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(META)).getFile();
    return JSON.parse(await file.text()) as Record<string, Attr>;
  } catch {
    return {};
  }
}

export async function saveMeta(attrs: Record<string, Attr>): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const writable = await (
    await root.getFileHandle(META, { create: true })
  ).createWritable();
  await writable.write(JSON.stringify(attrs));
  await writable.close();
}

/** Calls `save` once things go quiet, instead of on every chmod/mkdir. */
export function debounce(save: () => Promise<void>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save().catch(console.error), ms);
  };
}

/**
 * Before users existed, the OPFS root itself was /home. Move what's there
 * into home/<user> once, the first boot that finds no home/ directory.
 * ponytail: needs FileSystemHandle.move (all current browsers for OPFS);
 * where it's missing the old files just stay in the root, unreachable.
 */
export async function migrateLegacyHome(user: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);
  if (names.includes("home")) return;

  const target = await (
    await root.getDirectoryHandle("home", { create: true })
  ).getDirectoryHandle(user, { create: true });

  for (const name of names) {
    if (name === "etc" || name === META) continue;
    const handle = await root
      .getFileHandle(name)
      .catch(() => root.getDirectoryHandle(name));
    const movable = handle as FileSystemHandle & {
      move?(destination: FileSystemDirectoryHandle): Promise<void>;
    };
    await movable.move?.(target).catch(console.error);
  }
}
