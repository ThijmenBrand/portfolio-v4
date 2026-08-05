import {
  ebadf,
  eexist,
  einval,
  eisdir,
  enoent,
  enotdir,
  enotempty,
} from "../../errors";
import type { FileSystemDriver } from "../fsdriver";
import { isValidName } from "../path";
import type { NodeKind, Stat } from "../types";
import type { Node } from "../types";

const BRAND = Symbol("memfs");

interface MemNodeBase {
  readonly [BRAND]: true;
  createdAt: number;
  modifiedAt: number;
}

interface MemFile extends MemNodeBase {
  kind: "file";
  data: Uint8Array;
}

interface MemDirectory extends MemNodeBase {
  kind: "directory";
  children: Map<string, MemNode>;
}

type MemNode = MemFile | MemDirectory;

export class MemFS implements FileSystemDriver {
  private readonly rootNode: MemDirectory;

  constructor() {
    this.rootNode = this.makeDirectory();
  }

  public async root(): Promise<Node> {
    return this.rootNode;
  }

  public async lookup(parent: Node, name: string): Promise<Node | undefined> {
    const directory = this.assertDirectory(parent);
    return directory.children.get(name);
  }

  public async stat(node: Node): Promise<Stat> {
    const memNode = this.assertOwn(node);

    const size =
      memNode.kind === "file" ? memNode.data.length : memNode.children.size;

    return {
      kind: memNode.kind,
      size: size,
      createdAt: memNode.createdAt,
      modifiedAt: memNode.modifiedAt,
    };
  }

  public async readdir(node: Node): Promise<string[]> {
    const directory = this.assertDirectory(node);
    return Array.from(directory.children.keys());
  }

  public async read(
    node: Node,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const file = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);
    if (length < 0) throw einval(`Length cannot be negative: ${length}`);
    if (offset > file.data.length) offset = file.data.length;

    return file.data.slice(offset, offset + length);
  }

  public async write(
    node: Node,
    offset: number,
    data: Uint8Array,
  ): Promise<number> {
    const file = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);

    // if offset is greater than current data length, we need to expand the data
    if (offset + data.length > file.data.length) {
      const newData = new Uint8Array(offset + data.length);
      newData.set(file.data, 0);
      file.data = newData;
    }

    file.data.set(data, offset);
    file.modifiedAt = Date.now();
    return data.length;
  }

  public async truncate(node: Node, size: number): Promise<void> {
    const file = this.assertFile(node);
    if (size < 0) throw einval(`Size cannot be negative: ${size}`);

    if (size < file.data.length) {
      file.data = file.data.slice(0, size);
    } else if (size > file.data.length) {
      const newData = new Uint8Array(size);
      newData.set(file.data, 0);
      file.data = newData;
    }

    file.modifiedAt = Date.now();
  }

  public async create(
    parent: Node,
    name: string,
    kind: NodeKind,
  ): Promise<Node> {
    const directory = this.assertDirectory(parent);

    if (!isValidName(name)) {
      throw einval(name);
    }
    if (directory.children.has(name)) {
      throw eexist(name);
    }

    let newNode: MemNode;
    const now = Date.now();
    if (kind === "file") {
      newNode = {
        kind: "file",
        data: new Uint8Array(),
        createdAt: now,
        modifiedAt: now,
        [BRAND]: true,
      };
    } else if (kind === "directory") {
      newNode = {
        kind: "directory",
        children: new Map(),
        createdAt: now,
        modifiedAt: now,
        [BRAND]: true,
      };
    } else {
      throw einval(kind);
    }

    directory.children.set(name, newNode);
    directory.modifiedAt = Date.now();
    return newNode;
  }

  // Unlink a file, if its a directory throw
  public async unlink(parent: Node, name: string): Promise<void> {
    const directory = this.assertDirectory(parent);
    const target = directory.children.get(name);
    if (!target) throw enoent(name);
    if (target.kind === "directory") throw eisdir(name);

    directory.children.delete(name);
    directory.modifiedAt = Date.now();
  }

  public async rmdir(parent: Node, name: string): Promise<void> {
    const directory = this.assertDirectory(parent);
    const target = directory.children.get(name);
    if (!target) throw enoent(name);
    if (target.kind !== "directory") throw enotdir(name);
    if (target.children.size > 0) throw enotempty(name);

    directory.children.delete(name);
    directory.modifiedAt = Date.now();
  }

  private assertOwn(node: Node): MemNode {
    // assert if node is memfs node
    if (!(BRAND in node)) throw ebadf("node does not belong to memfs");
    return node as MemNode;
  }

  private assertDirectory(node: Node): MemDirectory {
    const own = this.assertOwn(node);
    if (own.kind !== "directory") throw enotdir("node is not a directory");
    return own;
  }

  private assertFile(node: Node): MemFile {
    const own = this.assertOwn(node);
    if (own.kind !== "file") throw eisdir("node is not a file");
    return own;
  }

  private makeDirectory(): MemDirectory {
    const now = Date.now();
    return {
      [BRAND]: true,
      children: new Map(),
      createdAt: now,
      modifiedAt: now,
      kind: "directory",
    };
  }
}
