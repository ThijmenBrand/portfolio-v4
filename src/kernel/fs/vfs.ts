import {
  ebusy,
  efbig,
  eintr,
  einval,
  eisdir,
  enotdir,
  erofs,
  KernelError,
} from "../errors";
import type { OpenFile, OpenFlags } from "../io/openfile.ts";
import {
  childMounts,
  findMount,
  mountAt,
  relativeSegments,
  walk,
} from "./mount";
import { basename, isValidName, normalize } from "./path";
import type { DirEntry, Mount, Node, StatResult } from "./types";
import { VfsFile } from "./vfsFile.ts";

export class VFS {
  private readonly mounts: Mount[] = [];

  private static readonly CHUNK_SIZE = 64 * 1024; // 64KB
  private static readonly MAX_SIZE = 64 * 1024 * 1024; // 64MB

  public mount(mount: Mount): void {
    const mountPath = normalize(mount.path);
    if (mountAt(this.mounts, mountPath)) {
      throw ebusy(`Mount point already exists: ${mountPath}`);
    }
    this.mounts.push({ ...mount, path: mountPath });
  }

  /**
   * returns the stat for a given path
   * @param path string
   * @returns Promise<StatResult>
   */
  public async stat(path: string): Promise<StatResult> {
    const { mount, node } = await this.resolve(path);
    const stat = await mount.driver.stat(node);
    const readonly = mount.readonly;
    return { ...stat, readonly };
  }

  public async readdir(path: string): Promise<DirEntry[]> {
    const dir = normalize(path);
    const { mount, node } = await this.resolve(dir);
    if (node.kind !== "directory") throw enotdir(dir);

    const names = new Set(
      (await mount.driver.readdir(node)).filter(isValidName),
    );
    childMounts(this.mounts, dir).forEach((childMount) => {
      names.add(basename(childMount.path));
    });

    // compose each file name into a direntry in parallel, ignoring transient errors
    const parent = { mount, node };
    const entries = (
      await Promise.all(
        Array.from(names).map((name) => this.composeEntry(dir, parent, name)),
      )
    ).filter((v): v is DirEntry => !!v);

    return entries;
  }

  public async open(path: string, flags: OpenFlags): Promise<OpenFile> {
    const normalized = normalize(path);

    if (!flags.read && !flags.write)
      throw einval(`open: no access mode: ${normalized}`);
    if (flags.truncate && !flags.write)
      throw einval(`open: O_TRUNC without write: ${normalized}`);

    const mount = findMount(this.mounts, normalized);
    if (flags.write) this.assertWritable(mount, normalized);

    const node = flags.create
      ? await this.openCreate(mount, normalized)
      : (await this.resolve(normalized)).node;

    if (node.kind !== "file") throw eisdir(normalized);
    if (flags.truncate) await mount.driver.truncate(node, 0);

    return (
      (await mount.driver.open?.(node, normalized)) ??
      new VfsFile(mount, node, normalized)
    );
  }

  public async readFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const file = await this.open(path, { read: true });
    try {
      return await this.readAll(file, 0, normalize(path), signal);
    } finally {
      await file.close();
    }
  }

  public async writeFile(
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = await this.open(path, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      await file.write(0, data, signal);
    } finally {
      await file.close();
    }
  }

  public async mkdir(path: string): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    await mount.driver.create(parent, name, "directory");
  }

  public async unlink(path: string): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    await mount.driver.unlink(parent, name);
  }

  public async rmdir(path: string): Promise<void> {
    const { mount, parent, name } = await this.resolveParent(path);
    this.assertWritable(mount, path);

    await mount.driver.rmdir(parent, name);
  }

  /**
   * resolves the mount and node based on a given path
   * @param path string
   * @returns
   * @throws einval
   * @throws enoent
   * @throws enotdir
   */
  public async resolve(path: string): Promise<{ mount: Mount; node: Node }> {
    const normalized = normalize(path);
    const mount = findMount(this.mounts, normalized);
    const segments = relativeSegments(mount, normalized);
    const node = await walk(mount, segments, normalized);

    return { mount, node };
  }

  public async resolveParent(
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

  private async openCreate(mount: Mount, path: string): Promise<Node> {
    const { parent, name } = await this.resolveParent(path);
    return (
      (await mount.driver.lookup(parent, name)) ??
      (await mount.driver.create(parent, name, "file"))
    );
  }

  private assertWritable(mount: Mount, path: string): void {
    if (!mount.readonly) return;

    throw erofs(path);
  }

  private async composeEntry(
    dir: string,
    parent: { mount: Mount; node: Node },
    name: string,
  ): Promise<DirEntry | null> {
    try {
      const childPath = dir === "/" ? `/${name}` : `${dir}/${name}`;
      const covering = mountAt(this.mounts, childPath);
      const source = covering ?? parent.mount;

      const node = covering
        ? await covering.driver.root()
        : await parent.mount.driver.lookup(parent.node, name);
      if (!node) return null;

      const stat = await source.driver.stat(node);
      return { name, ...stat, readonly: source.readonly };
    } catch (error) {
      if (VFS.isTransient(error)) return null;
      throw error;
    }
  }

  private async readAll(
    file: OpenFile,
    from: number,
    fullPath: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    let totalRead = 0;
    let position = from;
    const chunks: Uint8Array[] = [];

    while (true) {
      if (signal?.aborted) throw eintr(fullPath);

      const chunk = await file.read(position, VFS.CHUNK_SIZE, signal);
      if (chunk.length === 0) break; // End of file

      if (totalRead + chunk.length > VFS.MAX_SIZE) throw efbig(fullPath);

      totalRead += chunk.length;
      chunks.push(chunk);
      position += chunk.length;
    }

    const result = new Uint8Array(totalRead);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  private static isTransient(error: unknown): boolean {
    return (
      error instanceof KernelError &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    );
  }
}
