import { ebadf } from "../errors";
import type { Stat } from "../fs/types";
import type { Bytes } from "../types";
import type { OpenFile, PtyFds } from "./openfile";
import { PipeBuffer } from "./pipe";

let nextPtyId = 1;

export class PtyEnd implements OpenFile {
  public readonly seekable = false;
  private closed = false;

  private readonly inbound: PipeBuffer;
  private readonly outbound: PipeBuffer;
  public readonly description: string;

  public constructor(
    inbound: PipeBuffer,
    outbound: PipeBuffer,
    description: string,
  ) {
    this.inbound = inbound;
    this.outbound = outbound;
    this.description = description;
  }

  public async read(_offset: number, length: number, signal?: AbortSignal) {
    if (this.closed) throw ebadf(this.description);
    return this.inbound.read(length, signal);
  }

  public async write(_offset: number, data: Bytes, signal?: AbortSignal) {
    if (this.closed) throw ebadf(this.description);
    return this.outbound.write(data, signal);
  }

  public async stat(): Promise<Stat> {
    return this.inbound.stat();
  }

  public async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.inbound.closeRead();
    this.outbound.closeWrite();
  }
}

export function createPty(): PtyFds {
  const id = nextPtyId++;
  const toSlave = new PipeBuffer(); // master writes, slave reads
  const toMaster = new PipeBuffer(); // slave writes, master reads
  return {
    master: new PtyEnd(toMaster, toSlave, `pty:[${id}]:master`),
    slave: new PtyEnd(toSlave, toMaster, `pty:[${id}]:slave`),
  };
}
