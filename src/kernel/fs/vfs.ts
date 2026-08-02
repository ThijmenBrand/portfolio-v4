import { ebusy, einval, eisdir, enoent, erofs } from "../errors";
import { findMount, relativeSegments, walk } from "./mount";
import { normalize } from "./path";
import type { DirEntry, Mount, Node, Stat } from "./types";

export class VFS {
  private mounts: Mount[] = [];

  public mount(mount: Mount): void {
    mount.path = normalize(mount.path);
    this.mounts.push(mount);
  }

  public async stat(path: string): Promise<Stat> {
    const { mount, node } = await this.resolve(path);
    return mount.driver.stat(node);
  }

  public async readdir(path: string): Promise<DirEntry[]> {
    const { mount, node } = await this.resolve(path);
    const names = await mount.driver.readdir(node);
    return Promise.all(
      names.map(async (name) => {
        const childNode = await mount.driver.lookup(node, name);
        if (!childNode) throw enoent(`${path}/${name}`);
        const stat = await mount.driver.stat(childNode);
        return { name, ...stat };
      }),
    );
  }

  public async readFile(path: string): Promise<Uint8Array> {
    const { mount, node } = await this.resolve(path);
    const stat = await mount.driver.stat(node);
    return await mount.driver.read(node, 0, stat.size);
  }

  public async writeFile(path: string, data: Uint8Array): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    const existingNode = await mount.driver.lookup(parent, name);
    if (existingNode && existingNode.kind !== "directory") eisdir(path);
    if (!existingNode) {
      await mount.driver.create(parent, name, "file");
      await mount.driver.write(parent, 0, data);
      return;
    }

    await mount.driver.truncate(existingNode, 0);
    await mount.driver.write(existingNode, 0, data);
  }

  public async mkdir(path: string): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    mount.driver.create(parent, name, "directory");
  }

  public async unlink(path: string): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    mount.driver.unlink(parent, name);
  }

  async resolve(path: string): Promise<{ mount: Mount; node: Node }> {
    const normalized = normalize(path);
    const mount = findMount(this.mounts, normalized);
    const segments = relativeSegments(mount, normalized);
    const node = await walk(mount, segments, normalized);

    return { mount, node };
  }

  async resolveParent(
    path: string,
  ): Promise<{ mount: Mount; parent: Node; name: string }> {
    const normalized = normalize(path);
    const mount = findMount(this.mounts, normalized);
    const segments = relativeSegments(mount, normalized);

    if (normalized === "/") throw einval("Root has no parent");
    if (segments.length === 0) throw ebusy(normalized);

    const name = segments.pop()!;
    const parent = await walk(mount, segments, normalized);

    return { mount, parent, name };
  }

  private assertWritable(mount: Mount, path: string): void {
    if (!mount.readonly) return;

    throw erofs(path);
  }
}
