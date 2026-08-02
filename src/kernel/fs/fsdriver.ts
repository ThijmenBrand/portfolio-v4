import { type Node, type NodeKind, type Stat } from "./types";

export interface FileSystemDriver {
  root(): Promise<Node>;
  lookup(parent: Node, name: string): Promise<Node | undefined>;
  stat(node: Node): Promise<Stat>;
  readdir(node: Node): Promise<string[]>;
  read(node: Node, offset: number, length: number): Promise<Uint8Array>;
  write(node: Node, offset: number, data: Uint8Array): Promise<number>;
  truncate(node: Node, size: number): Promise<void>;
  create(parent: Node, name: string, kind: NodeKind): Promise<Node>;
  unlink(parent: Node, name: string): Promise<void>;
}
