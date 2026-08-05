import type { FileSystemDriver } from "./fsdriver";

export type NodeKind = "file" | "directory";

export type Node = { readonly kind: NodeKind };

export type Stat = {
  kind: NodeKind;
  size: number;
  createdAt: number;
  modifiedAt: number;
};

export interface Mount {
  path: string;
  driver: FileSystemDriver;
  readonly: boolean;
}

export interface DirEntry {
  name: string;
  kind: NodeKind;
  createdAt: number;
  modifiedAt: number;
  size: number;
  readonly: boolean;
}

export interface StatResult extends Stat {
  readonly: boolean;
}
