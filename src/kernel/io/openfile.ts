import type { Stat } from "../fs/types";
import type { Bytes } from "../types";
import type { PtyEnd } from "./pty";

export interface OpenFile {
  readonly description: string;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Bytes>;
  write(offset: number, data: Bytes, signal?: AbortSignal): Promise<number>;
  stat(): Promise<Stat>;
  close(): Promise<void>;
  readonly seekable: boolean;
}

export interface FdInfo {
  fd: number;
  description: string;
  flags: OpenFlags;
  offset: number;
  refs: number;
  seekable: boolean;
}

export interface PipeFds {
  read: number;
  write: number;
}

export interface PtyFds {
  master: PtyEnd;
  slave: PtyEnd;
}

export interface OpenFileDescription {
  readonly file: OpenFile;
  readonly flags: OpenFlags;
  offset: number;
  refs: number;
  lock: Promise<unknown>;
}

export type Whence = "set" | "cur" | "end";

export interface OpenFlags {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  truncate?: boolean;
  append?: boolean;
}
