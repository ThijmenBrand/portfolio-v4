import {
  eacces,
  ebusy,
  efbig,
  eintr,
  einval,
  eisdir,
  enotdir,
  epermPath,
  erofs,
  KernelError,
} from "../errors";
import type { OpenFile, OpenFlags } from "../io/openfile.ts";
import type { Bytes } from "../types.ts";
import {
  childMounts,
  findMount,
  mountAt,
  relativeSegments,
  walk,
} from "./mount";
import { basename, dirname, isValidName, normalize, split } from "./path";
import { defaultAttr, permits, R, ROOT, W, X, type Attr, type Cred } from "./perm";
import type { DirEntry, Mount, Node, NodeKind, StatResult } from "./types";
import { VfsFile } from "./vfsFile.ts";

/**
 * Every method takes the caller's credentials last; leaving them out means
 * root, which is what the kernel's own calls (boot, procfs) want.
 */
export class VFS {
  private readonly mounts: Mount[] = [];

  /**
   * Owner, group and mode per absolute path. Kept here rather than in the
   * drivers because OPFS can't store them; no entry means root-owned with the
   * default mode. Checks are map lookups, so "x on every parent" costs no I/O.
   */
  private readonly attrs = new Map<string, Attr>();

  /** Called after any change to `attrs`, so the kernel can persist them. */
  public onAttrsChange: () => void = () => {};

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
  public async stat(path: string, cred: Cred = ROOT): Promise<StatResult> {
    const normalized = normalize(path);
    this.assertSearch(normalized, cred);
    const { mount, node } = await this.resolve(normalized);
    const stat = await mount.driver.stat(node);
    const readonly = mount.readonly;
    return { ...stat, readonly, ...this.attr(normalized, stat.kind) };
  }

  /** Throws EACCES unless `cred` may reach `path` and do `want` (R|W|X) on it. */
  public async access(path: string, cred: Cred, want: number): Promise<void> {
    const normalized = normalize(path);
    this.assertSearch(normalized, cred);
    const { node } = await this.resolve(normalized);
    this.assertAccess(normalized, node.kind, cred, want);
  }

  public async readdir(path: string, cred: Cred = ROOT): Promise<DirEntry[]> {
    const dir = normalize(path);
    this.assertSearch(dir, cred);
    const { mount, node } = await this.resolve(dir);
    if (node.kind !== "directory") throw enotdir(dir);
    this.assertAccess(dir, node.kind, cred, R);

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

  public async open(
    path: string,
    flags: OpenFlags,
    cred: Cred = ROOT,
  ): Promise<OpenFile> {
    const normalized = normalize(path);

    if (!flags.read && !flags.write)
      throw einval(`open: no access mode: ${normalized}`);
    if (flags.truncate && !flags.write)
      throw einval(`open: O_TRUNC without write: ${normalized}`);

    const mount = findMount(this.mounts, normalized);
    if (flags.write) this.assertWritable(mount, normalized);
    this.assertSearch(normalized, cred);

    const { node, created } = flags.create
      ? await this.openCreate(mount, normalized, cred)
      : { node: (await this.resolve(normalized)).node, created: false };

    if (node.kind !== "file") throw eisdir(normalized);
    // A file we just made is ours to open, whatever its mode says.
    if (!created) {
      const want = (flags.read ? R : 0) | (flags.write ? W : 0);
      this.assertAccess(normalized, node.kind, cred, want);
    }
    if (flags.truncate) await mount.driver.truncate(node, 0);

    return (
      (await mount.driver.open?.(node, normalized)) ??
      new VfsFile(mount, node, normalized)
    );
  }

  public async readFile(
    path: string,
    signal?: AbortSignal,
    cred: Cred = ROOT,
  ): Promise<Bytes> {
    const file = await this.open(path, { read: true }, cred);
    try {
      return await this.readAll(file, 0, normalize(path), signal);
    } finally {
      await file.close();
    }
  }

  public async writeFile(
    path: string,
    data: Bytes,
    signal?: AbortSignal,
    cred: Cred = ROOT,
  ): Promise<void> {
    const file = await this.open(
      path,
      { write: true, create: true, truncate: true },
      cred,
    );
    try {
      await file.write(0, data, signal);
    } finally {
      await file.close();
    }
  }

  public async mkdir(path: string, cred: Cred = ROOT): Promise<void> {
    const normalized = normalize(path);
    const { mount, parent, name } = await this.resolveParent(normalized);
    this.assertWritable(mount, normalized);
    this.assertCanModifyParent(normalized, cred);

    await mount.driver.create(parent, name, "directory");
    this.setAttr(normalized, { uid: cred.euid, gid: cred.gid, mode: 0o755 });
  }

  public async unlink(path: string, cred: Cred = ROOT): Promise<void> {
    const normalized = normalize(path);
    const { mount, parent, name } = await this.resolveParent(normalized);
    this.assertWritable(mount, normalized);
    this.assertCanModifyParent(normalized, cred);

    await mount.driver.unlink(parent, name);
    this.dropAttr(normalized);
  }

  public async rmdir(path: string, cred: Cred = ROOT): Promise<void> {
    const normalized = normalize(path);
    const { mount, parent, name } = await this.resolveParent(normalized);
    this.assertWritable(mount, normalized);
    this.assertCanModifyParent(normalized, cred);

    await mount.driver.rmdir(parent, name);
    this.dropAttr(normalized);
  }

  /** Only the owner (or root) may change a mode. */
  public async chmod(path: string, mode: number, cred: Cred = ROOT): Promise<void> {
    const normalized = normalize(path);
    const { mount, node } = await this.resolveChecked(normalized, cred);
    this.assertWritable(mount, normalized);
    const current = this.attr(normalized, node.kind);
    if (cred.euid !== 0 && cred.euid !== current.uid) throw epermPath(normalized);
    this.setAttr(normalized, { ...current, mode: mode & 0o777 });
  }

  /** Only root may give a file away. */
  public async chown(
    path: string,
    uid: number,
    gid: number,
    cred: Cred = ROOT,
  ): Promise<void> {
    const normalized = normalize(path);
    const { mount, node } = await this.resolveChecked(normalized, cred);
    this.assertWritable(mount, normalized);
    if (cred.euid !== 0) throw epermPath(normalized);
    this.setAttr(normalized, { ...this.attr(normalized, node.kind), uid, gid });
  }

  /**
   * Kernel-only: set attributes without any check, e.g. on read-only
   * mounts at boot (program files) or when loading saved attributes.
   */
  public setAttr(path: string, attr: Attr): void {
    this.attrs.set(normalize(path), { ...attr });
    this.onAttrsChange();
  }

  /** Every stored attribute whose path is under one of `prefixes`. */
  public attrsUnder(prefixes: string[]): Record<string, Attr> {
    const under = (path: string) =>
      prefixes.some((p) => path === p || path.startsWith(`${p}/`));
    return Object.fromEntries(
      [...this.attrs].filter(([path]) => under(path)),
    );
  }

  /** Bulk load, e.g. the saved attributes at boot. Doesn't notify. */
  public loadAttrs(saved: Record<string, Attr>): void {
    for (const [path, attr] of Object.entries(saved)) {
      this.attrs.set(normalize(path), attr);
    }
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

  private async openCreate(
    mount: Mount,
    path: string,
    cred: Cred,
  ): Promise<{ node: Node; created: boolean }> {
    const { parent, name } = await this.resolveParent(path);
    const existing = await mount.driver.lookup(parent, name);
    if (existing) return { node: existing, created: false };

    this.assertCanModifyParent(path, cred);
    const node = await mount.driver.create(parent, name, "file");
    this.setAttr(path, { uid: cred.euid, gid: cred.gid, mode: 0o644 });
    return { node, created: true };
  }

  private async resolveChecked(
    path: string,
    cred: Cred,
  ): Promise<{ mount: Mount; node: Node }> {
    this.assertSearch(path, cred);
    return this.resolve(path);
  }

  /**
   * No entry: the default mode, owned by whoever owns the nearest directory
   * above that has one. That's how files that appeared in OPFS behind our
   * back (or before users existed) end up belonging to the home's owner.
   */
  private attr(path: string, kind: NodeKind): Attr {
    const own = this.attrs.get(path);
    if (own) return own;
    const fallback = defaultAttr(kind);
    for (let dir = path; dir !== "/"; ) {
      dir = dirname(dir);
      const above = this.attrs.get(dir);
      if (above) return { ...fallback, uid: above.uid, gid: above.gid };
    }
    return fallback;
  }

  private dropAttr(path: string): void {
    if (this.attrs.delete(path)) this.onAttrsChange();
  }

  private assertAccess(
    path: string,
    kind: NodeKind,
    cred: Cred,
    want: number,
  ): void {
    if (!permits(this.attr(path, kind), cred, want)) throw eacces(path);
  }

  /** x on every directory above `path` (not `path` itself). */
  private assertSearch(path: string, cred: Cred): void {
    if (cred.euid === 0) return;
    let dir = "/";
    for (const segment of split(path).slice(0, -1)) {
      this.assertAccess(dir, "directory", cred, X);
      dir = dir === "/" ? `/${segment}` : `${dir}/${segment}`;
    }
    if (path !== "/") this.assertAccess(dir, "directory", cred, X);
  }

  /** Creating or removing an entry needs w+x on the directory holding it. */
  private assertCanModifyParent(path: string, cred: Cred): void {
    this.assertSearch(path, cred);
    this.assertAccess(dirname(path), "directory", cred, W | X);
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
      return {
        name,
        ...stat,
        readonly: source.readonly,
        ...this.attr(childPath, stat.kind),
      };
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
  ): Promise<Bytes> {
    let totalRead = 0;
    let position = from;
    const chunks: Bytes[] = [];

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
