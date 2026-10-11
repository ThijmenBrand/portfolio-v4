import type { OpenFile } from "../io/openfile";
import type { Bytes } from "../types";
import { type Node, type NodeKind, type Stat } from "./types";

export interface FileSystemDriver {
  root(): Promise<Node>;
  lookup(parent: Node, name: string): Promise<Node | undefined>;
  stat(node: Node): Promise<Stat>;
  readdir(node: Node): Promise<string[]>;
  read(node: Node, offset: number, length: number): Promise<Bytes>;
  write(node: Node, offset: number, data: Bytes): Promise<number>;
  truncate(node: Node, size: number): Promise<void>;
  create(parent: Node, name: string, kind: NodeKind): Promise<Node>;
  rmdir(parent: Node, name: string): Promise<void>;
  unlink(parent: Node, name: string): Promise<void>;
  /**
   * Move an entry within this driver, replacing `toName` if it exists (the
   * VFS has checked it's the same kind, and empty if a directory). Throws
   * EXDEV, before touching anything, when it can't: callers copy instead.
   */
  rename?(
    fromParent: Node,
    fromName: string,
    toParent: Node,
    toName: string,
  ): Promise<void>;
  open?(node: Node, path: string): Promise<OpenFile>;
}
