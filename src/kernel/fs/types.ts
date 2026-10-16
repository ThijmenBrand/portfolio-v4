import type { FileSystemDriver } from "./fsdriver";

export type NodeKind = "file" | "directory" | "fifo";

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
  /**
   * Served by the backend rather than by this browser. Such a mount reaches
   * the owner's private API, so the VFS keeps filesystem code off it and
   * gives it fixed permissions (fs/perm.ts remoteAttr).
   */
  remote?: boolean;
}

export interface DirEntry {
  name: string;
  kind: NodeKind;
  createdAt: number;
  modifiedAt: number;
  size: number;
  readonly: boolean;
  uid: number;
  gid: number;
  mode: number;
}

export interface StatResult extends Stat {
  readonly: boolean;
  uid: number;
  gid: number;
  mode: number;
}
