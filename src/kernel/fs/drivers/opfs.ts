import {
  ebadf,
  ebusy,
  eexist,
  einval,
  eio,
  eisdir,
  enoent,
  enospc,
  enotdir,
  enotempty,
  KernelError,
} from "../../errors";
import type { Bytes } from "../../types";
import type { FileSystemDriver } from "../fsdriver";
import { isValidName } from "../path";
import type { Node, NodeKind, Stat } from "../types";

const BRAND = Symbol("opfs");

interface OpfsFileNode {
  readonly [BRAND]: true;
  kind: "file";
  handle: FileSystemFileHandle;
}

interface OpfsDirNode {
  readonly [BRAND]: true;
  kind: "directory";
  handle: FileSystemDirectoryHandle;
}

type OpfsNode = OpfsFileNode | OpfsDirNode;

function isDomError(error: unknown, name: string): boolean {
  return error instanceof DOMException && error.name === name;
}

function translate(error: unknown, subject: string): unknown {
  if (error instanceof KernelError) return error; // already ours — pass through
  if (!(error instanceof DOMException)) return error;

  switch (error.name) {
    case "NotFoundError":
      return enoent(subject);
    case "TypeMismatchError":
      return enotdir(subject);
    case "InvalidModificationError":
      return enotempty(subject);
    case "NoModificationAllowedError":
      return ebusy(subject); // concurrent writable
    case "QuotaExceededError":
      return enospc(subject);
    default:
      return eio(`${subject}: ${error.name}`);
  }
}

export function opfsAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

export class OpfsFS implements FileSystemDriver {
  private readonly bootedAt = Date.now();

  private rootPromise?: Promise<OpfsDirNode>;

  public async root(): Promise<OpfsNode> {
    this.rootPromise ??= this.guard("/", async () => ({
      [BRAND]: true as const,
      kind: "directory" as const,
      handle: await navigator.storage.getDirectory(),
    })).catch((error: unknown) => {
      this.rootPromise = undefined;
      throw error;
    });

    return this.rootPromise;
  }

  public async lookup(
    parent: Node,
    name: string,
  ): Promise<OpfsNode | undefined> {
    const dir = this.assertDirectory(parent);
    if (!isValidName(name)) return undefined;

    const file = await this.tryGet(() => dir.handle.getFileHandle(name));
    if (file) return { [BRAND]: true, kind: "file", handle: file };

    const child = await this.tryGet(() => dir.handle.getDirectoryHandle(name));
    if (child) return { [BRAND]: true, kind: "directory", handle: child };

    return undefined;
  }

  /** NotFound = absent. TypeMismatch = present, but the other kind. */
  private async tryGet<T>(get: () => Promise<T>): Promise<T | undefined> {
    try {
      return await get();
    } catch (error) {
      if (isDomError(error, "NotFoundError")) return undefined;
      if (isDomError(error, "TypeMismatchError")) return undefined;
      throw error;
    }
  }

  public async stat(node: Node): Promise<Stat> {
    const own = this.assertOwn(node);

    return this.guard(this.subject(own), async () => {
      if (own.kind === "directory") {
        let size = 0;
        for await (const _ of own.handle.keys()) size += 1;

        return {
          kind: "directory" as const,
          size,
          createdAt: this.bootedAt,
          modifiedAt: this.bootedAt,
        };
      }

      const file = await own.handle.getFile();
      return {
        kind: "file" as const,
        size: file.size,
        createdAt: file.lastModified,
        modifiedAt: file.lastModified,
      };
    });
  }

  public async readdir(node: Node): Promise<string[]> {
    const dir = this.assertDirectory(node);

    return this.guard(this.subject(dir), async () => {
      const names: string[] = [];
      for await (const name of dir.handle.keys()) names.push(name);
      return names;
    });
  }

  public async read(
    node: Node,
    offset: number,
    length: number,
  ): Promise<Bytes> {
    const own = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);
    if (length < 0) throw einval(`Length cannot be negative: ${length}`);

    // getFile() throws NotFoundError if the entry was removed while open —
    // memfs keeps the node alive here, OPFS cannot. ENOENT is the honest answer.
    return this.guard(own.handle.name, async () => {
      const file = await own.handle.getFile();
      return new Uint8Array(
        await file.slice(offset, offset + length).arrayBuffer(),
      );
    });
  }

  public async write(node: Node, offset: number, data: Bytes): Promise<number> {
    const own = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);

    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);

    await this.commit(own, (w) =>
      w.write({ type: "write", position: offset, data: bytes }),
    );
    return data.length;
  }

  public async truncate(node: Node, size: number): Promise<void> {
    const own = this.assertFile(node);
    if (size < 0) throw einval(`Size cannot be negative: ${size}`);
    await this.commit(own, (w) => w.truncate(size));
  }

  private async commit(
    node: OpfsFileNode,
    operation: (writable: FileSystemWritableFileStream) => Promise<void>,
  ): Promise<void> {
    return this.guard(node.handle.name, async () => {
      const writable = await node.handle.createWritable({
        keepExistingData: true,
      });
      try {
        await operation(writable);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    });
  }

  public async create(
    parent: Node,
    name: string,
    kind: NodeKind,
  ): Promise<OpfsNode> {
    const dir = this.assertDirectory(parent);
    if (!isValidName(name)) throw einval(name);
    if (kind !== "file" && kind !== "directory") throw einval(kind);

    if (await this.lookup(dir, name)) throw eexist(name);

    if (kind === "file") {
      const handle = await this.guard(name, () =>
        dir.handle.getFileHandle(name, { create: true }),
      );
      return { [BRAND]: true, kind: "file", handle };
    }

    const handle = await this.guard(name, () =>
      dir.handle.getDirectoryHandle(name, { create: true }),
    );
    return { [BRAND]: true, kind: "directory", handle };
  }

  public async unlink(parent: Node, name: string): Promise<void> {
    const dir = this.assertDirectory(parent);
    const target = await this.lookup(dir, name);
    if (!target) throw enoent(name);
    if (target.kind === "directory") throw eisdir(name);

    await this.guard(name, () => dir.handle.removeEntry(name));
  }

  public async rmdir(parent: Node, name: string): Promise<void> {
    const dir = this.assertDirectory(parent);
    const target = await this.lookup(dir, name);
    if (!target) throw enoent(name);
    if (target.kind !== "directory") throw enotdir(name);

    await this.guard(name, () => dir.handle.removeEntry(name));
  }

  private subject(node: OpfsNode): string {
    return node.handle.name || "/";
  }

  private async guard<T>(
    subject: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw translate(error, subject);
    }
  }

  private assertOwn(node: Node): OpfsNode {
    if (!(BRAND in node)) throw ebadf("node does not belong to opfs");
    return node as OpfsNode;
  }

  private assertDirectory(node: Node): OpfsDirNode {
    const own = this.assertOwn(node);
    if (own.kind !== "directory") throw enotdir("node is not a directory");
    return own;
  }

  private assertFile(node: Node): OpfsFileNode {
    const own = this.assertOwn(node);
    if (own.kind !== "file") throw eisdir("node is not a file");
    return own;
  }
}
