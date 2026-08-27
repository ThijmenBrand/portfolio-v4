import { ebadf, einval, eisdir, enotdir, erofs, esrch } from "../../errors";
import type { OpenFile } from "../../io/openfile";
import type { Pid, ProcessInfo } from "../../types";
import type { FileSystemDriver } from "../fsdriver";
import { SnapshotFile } from "../snapshotFile";
import type { Node, NodeKind, Stat } from "../types";

const BRAND = Symbol("procfs");

interface ProcNodeBase {
  readonly [BRAND]: true;
  createdAt: number;
  updatedAt: number;
}

interface ProcFile extends ProcNodeBase {
  kind: "file";
  content(): string;
}

interface ProcDirectory extends ProcNodeBase {
  kind: "directory";
  children(): string[];
  child(name: string): ProcNode | undefined;
}

type ProcNode = ProcFile | ProcDirectory;

type ProcSource = {
  list(): ProcessInfo[];
};

export class ProcFS implements FileSystemDriver {
  private static readonly encoder: TextEncoder = new TextEncoder();

  private readonly rootNode: ProcDirectory;
  private readonly source: ProcSource;
  private readonly bootedAt: number;

  /** Files directly under /proc. One table drives children() and child(). */
  private readonly statics: Record<string, () => string> = {
    uptime: () => `${((Date.now() - this.bootedAt) / 1000).toFixed(2)}\n`,
    version: () => "ProcFS Version 1.0\n",
  };

  /** Files under /proc/<pid>/. Generators take the pid they were built for. */
  private readonly processFiles: Record<string, (pid: Pid) => string> = {
    status: (pid) => this.formatStatus(pid),
    cmdline: (pid) => this.formatcmdline(pid),
    cwd: (pid) => this.formatcwd(pid),
  };

  public constructor(source: ProcSource) {
    this.source = source;
    this.bootedAt = Date.now();
    this.rootNode = this.makeRoot();
  }

  public async root(): Promise<Node> {
    return this.rootNode;
  }

  public async lookup(parent: Node, name: string): Promise<Node | undefined> {
    const directory = this.assertDirectory(parent);
    return directory.child(name);
  }

  public async stat(node: Node): Promise<Stat> {
    const procNode = this.assertOwn(node);

    const size = procNode.kind === "file" ? 0 : procNode.children().length;

    return {
      kind: procNode.kind,
      size: size,
      createdAt: procNode.createdAt,
      modifiedAt: procNode.updatedAt,
    };
  }

  public async readdir(node: Node): Promise<string[]> {
    const directory = this.assertDirectory(node);
    return directory.children();
  }

  public async open(node: Node): Promise<OpenFile> {
    const file = this.assertFile(node);
    const bytes = ProcFS.encoder.encode(file.content());

    return new SnapshotFile(
      bytes,
      {
        kind: "file",
        size: bytes.length,
        createdAt: file.createdAt,
        modifiedAt: file.updatedAt,
      },
      "procfs",
    );
  }

  public async read(
    node: Node,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const file = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);
    if (length < 0) throw einval(`Length cannot be negative: ${length}`);

    const text = file.content();
    const bytes = ProcFS.encoder.encode(text);
    if (offset >= bytes.length) return new Uint8Array(0);
    return bytes.slice(offset, offset + length);
  }

  public async write(
    _node: Node,
    _offset: number,
    _data: Uint8Array,
  ): Promise<number> {
    throw erofs("Write operation is not supported on procfs");
  }

  public async truncate(_node: Node, _size: number): Promise<void> {
    throw erofs("Truncate operation is not supported on procfs");
  }

  public async create(
    _parent: Node,
    _name: string,
    _kind: NodeKind,
  ): Promise<Node> {
    throw erofs("Create operation is not supported on procfs");
  }

  public async unlink(_parent: Node, _name: string): Promise<void> {
    throw erofs("Unlink operation is not supported on procfs");
  }

  public async rmdir(_parent: Node, _name: string): Promise<void> {
    throw erofs("Rmdir operation is not supported on procfs");
  }

  private assertOwn(node: Node): ProcNode {
    if (!(BRAND in node)) throw ebadf("node does not belong to procfs");
    return node as ProcNode;
  }

  private assertDirectory(node: Node): ProcDirectory {
    const own = this.assertOwn(node);
    if (own.kind !== "directory") throw enotdir("node is not a directory");
    return own;
  }

  private assertFile(node: Node): ProcFile {
    const own = this.assertOwn(node);
    if (own.kind !== "file") throw eisdir("node is not a file");
    return own;
  }

  private find(pid: Pid): ProcessInfo {
    const info = this.source.list().find((p) => p.pid === pid);
    if (!info) throw esrch(pid);
    return info;
  }

  private formatStatus(pid: Pid): string {
    const info = this.find(pid);
    return [
      `Pid:\t${info.pid}`,
      `PPid:\t${info.parentPid}`,
      `State:\t${info.status}`,
      `Path:\t${info.path}`,
      `Faults:\t${info.faults}`,
      "",
    ].join("\n");
  }

  private formatcmdline(pid: Pid): string {
    const info = this.find(pid);
    return [info.path, ...info.args].map((arg) => `${arg}\0`).join("");
  }

  private formatcwd(pid: Pid): string {
    return this.find(pid).cwd;
  }

  private makeDirectory(
    createdAt: number,
    children: () => string[],
    child: (name: string) => ProcNode | undefined,
  ): ProcDirectory {
    return {
      [BRAND]: true,
      kind: "directory",
      createdAt,
      updatedAt: createdAt,
      children,
      child,
    };
  }

  private makeFile(content: () => string, createdAt: number): ProcFile {
    return {
      [BRAND]: true,
      kind: "file",
      createdAt,
      updatedAt: createdAt,
      content,
    };
  }

  private makeRoot(): ProcDirectory {
    return this.makeDirectory(
      this.bootedAt,
      () => [
        ...Object.keys(this.statics),
        ...this.source.list().map((p) => String(p.pid)),
      ],
      (name) => {
        const generate = this.statics[name];
        if (generate) return this.makeFile(generate, this.bootedAt);

        // Strict: parseInt would let "42abc" and "007" alias process 42/7.
        if (!/^\d+$/.test(name)) return undefined;

        // The scan that proves the process exists also yields startedAt.
        const info = this.source.list().find((p) => String(p.pid) === name);
        if (!info) return undefined;

        return this.makeProcessDirectory(info.pid, info.startedAt);
      },
    );
  }

  private makeProcessDirectory(pid: Pid, startedAt: number): ProcDirectory {
    return this.makeDirectory(
      startedAt,
      () => Object.keys(this.processFiles),
      (name) => this.makeChildFile(pid, startedAt, name),
    );
  }

  private makeChildFile(
    pid: Pid,
    startedAt: number,
    name: string,
  ): ProcFile | undefined {
    const generate = this.processFiles[name];
    if (!generate) return undefined;
    return this.makeFile(() => generate(pid), startedAt);
  }
}
