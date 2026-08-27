import { ebadf } from "../errors";
import type { Stat } from "../fs/types";
import type { OpenFile } from "./openfile";

export class PipeReadEnd implements OpenFile {
  private readonly buffer: PipeBuffer;
  public readonly description: string;
  public readonly seekable: boolean;

  constructor(description: string) {
    this.description = description;
    this.seekable = false;
  }

  read(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {}

  write(
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<number> {
    throw ebadf("can't write a read pipe");
  }
  stat(): Promise<Stat> {
    throw new Error("Method not implemented.");
  }
  close(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
