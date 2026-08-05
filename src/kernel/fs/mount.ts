import { enoent, enotdir } from "../errors";
import { dirname } from "./path";
import type { Mount, Node } from "./types";

export function findMount(mounts: Mount[], path: string): Mount {
  let bestMatch: Mount | null = null;
  // Iterate through the mounts to find the best match for the given path
  for (const mount of mounts) {
    const prefix = mount.path === "/" ? "/" : mount.path + "/";
    if (path === mount.path || path.startsWith(prefix)) {
      if (!bestMatch || mount.path.length > bestMatch.path.length) {
        bestMatch = mount;
      }
    }
  }

  if (!bestMatch) {
    throw enoent(path);
  }

  return bestMatch;
}

export function mountAt(mounts: Mount[], path: string): Mount | undefined {
  return mounts.find((mount) => mount.path === path);
}

export function childMounts(mounts: Mount[], path: string): Mount[] {
  return mounts.filter(
    (mount) => mount.path !== path && dirname(mount.path) === path,
  );
}

export function relativeSegments(mount: Mount, path: string): string[] {
  if (path === mount.path) {
    return [];
  }

  const relativePath = path.slice(mount.path.length);
  return relativePath.split("/").filter(Boolean);
}

export async function walk(
  mount: Mount,
  segments: string[],
  fullPath: string,
): Promise<Node> {
  let root = mount.driver.root();
  for (const segment of segments) {
    const currentNode = await root;
    if (currentNode.kind !== "directory") throw enotdir(fullPath);

    const nextNode = await mount.driver.lookup(currentNode, segment);
    if (!nextNode) throw enoent(fullPath);

    root = Promise.resolve(nextNode);
  }

  return root;
}
