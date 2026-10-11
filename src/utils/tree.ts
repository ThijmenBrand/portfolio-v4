// Whole-tree file operations on top of the fs syscalls, shared by mv and Files.
import type { AppInterface } from "../kernel/syscalls/api";

/** Not path.join: that one wants absolute paths, and mv passes relative ones. */
const join = (dir: string, name: string): string => `${dir.replace(/\/+$/, "")}/${name}`;

/**
 * rename, or copy + delete where the kernel can't (EXDEV: across mounts, or
 * a directory on OPFS, which has no directory move), like mv.
 */
export async function moveTree(os: AppInterface, src: string, dst: string): Promise<void> {
  try {
    await os.fs.rename(src, dst);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await copyTree(os, src, dst);
    await removeTree(os, src);
  }
}

export async function copyTree(os: AppInterface, src: string, dst: string): Promise<void> {
  const stat = await os.fs.stat(src);
  if (stat.kind === "directory") {
    await os.fs.mkdir(dst);
    for (const entry of await os.fs.readdir(src))
      await copyTree(os, join(src, entry.name), join(dst, entry.name));
  } else if (stat.kind === "file") {
    await os.fs.writeFile(dst, await os.fs.readFile(src));
  }
}

export async function removeTree(os: AppInterface, path: string): Promise<void> {
  const stat = await os.fs.stat(path);
  if (stat.kind === "directory") {
    for (const entry of await os.fs.readdir(path))
      await removeTree(os, join(path, entry.name));
    await os.fs.rmdir(path);
  } else {
    await os.fs.unlink(path);
  }
}
