import { ebadf } from "../errors";
import type { OpenFile } from "./openfile";
import type { Mount, Node, StatResult } from "./types";

export class VfsFile implements OpenFile {
  public readonly seekable: boolean = true;
  private closed: boolean = false;

  private readonly mount: Mount;
  private readonly node: Node;
  private readonly path: string;

  public constructor(mount: Mount, node: Node, path: string) {
    this.mount = mount;
    this.node = node;
    this.path = path;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    return this.mount.driver.read(this.node, offset, length);
  }

  public async write(offset: number, data: Uint8Array): Promise<number> {
    this.assertOpen();
    return this.mount.driver.write(this.node, offset, data);
  }

  public async stat(): Promise<StatResult> {
    this.assertOpen();
    return {
      ...(await this.mount.driver.stat(this.node)),
      readonly: this.mount.readonly,
    };
  }

  public async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;
  }

  private assertOpen() {
    if (this.closed) throw ebadf(this.path);
  }
}
