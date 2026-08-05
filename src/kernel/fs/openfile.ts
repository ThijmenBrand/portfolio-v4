import type { StatResult } from "./types";

export interface OpenFile {
  read(offset: number, length: number): Promise<Uint8Array>;
  write(offset: number, data: Uint8Array): Promise<number>;
  stat(): Promise<StatResult>;
  close(): Promise<void>;
  readonly seekable: boolean;
}

export interface OpenFileDescription {
  readonly file: OpenFile;
  readonly flags: OpenFlags;
  offset: number;
  refs: number;
}

export interface OpenFlags {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  truncate?: boolean;
  append?: boolean;
}
