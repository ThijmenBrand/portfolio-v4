// The Bin: ~/.Trash holds the items, ~/.Trash/.info/<name>.json where each came from.
import type { AppInterface } from "../kernel/syscalls/api";
import { freeName } from "../apps/files/names";
import { moveTree, removeTree } from "./tree";

export const trashDir = (home: string): string => `${home.replace(/\/+$/, "")}/.Trash`;

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string): string => p.slice(0, Math.max(p.lastIndexOf("/"), 1));
const infoPath = (home: string, name: string): string => `${trashDir(home)}/.info/${name}.json`;

const names = async (os: AppInterface, dir: string): Promise<Set<string>> =>
  new Set((await os.fs.readdir(dir).catch(() => [])).map((entry) => entry.name));

async function mkdirs(os: AppInterface, path: string): Promise<void> {
  if (path === "/" || (await os.fs.stat(path).then(() => true, () => false))) return;
  await mkdirs(os, dirname(path));
  await os.fs.mkdir(path).catch(() => {});
}

/** Move `paths` into the Bin. Returns the names they got there. */
export async function trash(os: AppInterface, home: string, paths: string[]): Promise<string[]> {
  const dir = trashDir(home);
  await mkdirs(os, `${dir}/.info`);
  const taken = await names(os, dir);
  const landed: string[] = [];
  for (const src of paths) {
    const name = freeName(basename(src), taken);
    taken.add(name);
    await moveTree(os, src, `${dir}/${name}`);
    await os.fs.writeTextFile(infoPath(home, name), JSON.stringify({ path: src, deletedAt: Date.now() }));
    landed.push(name);
  }
  return landed;
}

/** Put `name` back where it came from (its folder is recreated if gone). Returns where it landed. */
export async function restore(os: AppInterface, home: string, name: string): Promise<string> {
  const info = await os.fs
    .readTextFile(infoPath(home, name))
    .then((text) => JSON.parse(text) as { path: string })
    .catch(() => ({ path: `${home}/${name}` }));
  const parent = dirname(info.path);
  await mkdirs(os, parent);
  const dst = `${parent === "/" ? "" : parent}/${freeName(basename(info.path), await names(os, parent))}`;
  await moveTree(os, `${trashDir(home)}/${name}`, dst);
  await os.fs.unlink(infoPath(home, name)).catch(() => {});
  return dst;
}

/** Delete `name` from the Bin for good. */
export async function purge(os: AppInterface, home: string, name: string): Promise<void> {
  await removeTree(os, `${trashDir(home)}/${name}`);
  await os.fs.unlink(infoPath(home, name)).catch(() => {});
}

export async function emptyTrash(os: AppInterface, home: string): Promise<void> {
  for (const name of await names(os, trashDir(home)))
    await removeTree(os, `${trashDir(home)}/${name}`);
}

/** Items in the Bin, not counting the hidden .info folder. */
export async function trashCount(os: AppInterface, home: string): Promise<number> {
  return [...(await names(os, trashDir(home)))].filter((name) => name !== ".info").length;
}
