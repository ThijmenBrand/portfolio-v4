import {
  ebusy,
  eacces,
  eexist,
  efbig,
  einval,
  eio,
  eisdir,
  enoent,
  enospc,
  enotdir,
  enotempty,
  KernelError,
} from "../../errors";
import type { OpenFile } from "../../io/openfile";
import type { Bytes } from "../../types";
import type { FileSystemDriver } from "../fsdriver";
import { isValidName } from "../path";
import type { Node, NodeKind, Stat } from "../types";

/**
 * A filesystem the server keeps, reached over the API instead of out of this
 * browser's storage. That is the whole point: OPFS is per browser profile, so
 * anything kept there follows the browser rather than the person. This
 * follows the person.
 *
 * Only the kernel can use it. Realms have an opaque origin and
 * `connect-src 'none'`, so they could not make this request or carry the
 * session cookie; they reach it the ordinary way, through fs syscalls, and
 * the VFS decides who may (fs/perm.ts remoteAttr, fs/vfs.ts mountFor).
 *
 * Write-through: no local copy, so two browsers never disagree, and nothing
 * works offline. Every write carries the version it is replacing, so a tab
 * that has been sitting on a stale file loses instead of overwriting.
 */

const BRAND = Symbol("remotefs");

interface RemoteNode {
  readonly [BRAND]: true;
  kind: NodeKind;
  /** Absolute within the mount; "/" is the mount root. */
  path: string;
  /** The version this node was last seen at; 0 while it is still pending. */
  version: number;
  /**
   * Created locally and not sent yet. The VFS creates a file and then opens
   * it, so holding the create back until the first flush turns two round
   * trips into one -- and leaves nothing behind if the write is rejected.
   */
  pending?: boolean;
  /** O_TRUNC arrived before open(); the open file applies it. */
  truncated?: boolean;
}

interface Entry {
  name: string;
  path: string;
  kind: NodeKind;
  size: number;
  version: number;
  createdAt: number;
  modifiedAt: number;
}

/** Matches MAX_FILE in server/fsstore.ts; checked here to skip a doomed upload. */
const MAX_FILE = 20 * 1024 * 1024;

/**
 * How long a directory listing may be reused. The VFS resolves a path one
 * segment at a time and composes a listing entry per child, so a single `ls`
 * asks about the same directory many times over; without this each one would
 * be its own request. Long enough to cover one such burst and no longer.
 *
 * ponytail: a listing can answer for this long after the session ends, since
 * a cache hit makes no request and so never sees the 401 that clears it. It
 * holds names, never bytes, and the VFS turns away anyone outside the admin
 * group before the driver is reached -- so reaching a stale listing means
 * already having been signed in. forget() is here for a session hook to call.
 */
const TTL = 1500;

/** Server error codes, which say more than the HTTP status does. */
const CODES: Record<string, (subject: string) => KernelError> = {
  ENOENT: enoent,
  ENOTDIR: enotdir,
  EISDIR: eisdir,
  EEXIST: eexist,
  ENOTEMPTY: enotempty,
  EBUSY: ebusy,
  ENOSPC: enospc,
  EFBIG: efbig,
  EINVAL: einval,
};

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export class RemoteFS implements FileSystemDriver {
  private readonly base: string;
  private readonly bootedAt = Date.now();

  /** Directory listings, by path. Entries come from one request each. */
  private readonly dirs = new Map<string, { at: number; entries: Map<string, Entry> }>();

  public constructor(base: string) {
    this.base = base;
  }

  // ----------------------------------------------------------- transport --

  private async call(
    route: string,
    query: Record<string, string>,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(`${this.base}/${route}`, window.location.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await fetch(url, { credentials: "same-origin", ...init });
    } catch {
      // Offline, or the backend is down. The mount stays visible and says so.
      throw eio(`${route}: cannot reach the server`);
    }
    if (response.ok) return response;

    // Signed out: nothing cached may outlive the session.
    if (response.status === 401 || response.status === 403) {
      this.dirs.clear();
      throw eacces(query.path ?? route);
    }
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    const make = body.code ? CODES[body.code] : undefined;
    if (make) throw make(query.path ?? route);
    if (response.status === 404) throw enoent(query.path ?? route);
    if (response.status === 413) throw efbig(query.path ?? route);
    if (response.status === 429) throw ebusy(query.path ?? route);
    if (response.status === 507) throw enospc(query.path ?? route);
    throw eio(`${route}: server answered ${response.status}`);
  }

  private async post(route: string, body: Record<string, unknown>): Promise<void> {
    await this.call(route, {}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    this.dirs.clear();
  }

  /** Drop everything remembered, e.g. when the session ends. */
  public forget(): void {
    this.dirs.clear();
  }

  /** A write only changes its own entry and the listing holding it. */
  private invalidate(path: string): void {
    this.dirs.delete(path);
    this.dirs.delete(parentOf(path));
  }

  // --------------------------------------------------------------- cache --

  private async listing(path: string): Promise<Map<string, Entry>> {
    const cached = this.dirs.get(path);
    if (cached && Date.now() - cached.at < TTL) return cached.entries;

    const response = await this.call("list", { path });
    const { entries } = (await response.json()) as { entries: Entry[] };
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    this.dirs.set(path, { at: Date.now(), entries: byName });
    return byName;
  }

  private async entryFor(path: string): Promise<Entry | undefined> {
    if (path === "/") return undefined; // the root is not in any listing
    return (await this.listing(parentOf(path))).get(path.slice(path.lastIndexOf("/") + 1));
  }

  private node(entry: Entry): RemoteNode {
    return {
      [BRAND]: true,
      kind: entry.kind,
      path: entry.path,
      version: entry.version,
    };
  }

  // -------------------------------------------------------------- driver --

  public async root(): Promise<RemoteNode> {
    return { [BRAND]: true, kind: "directory", path: "/", version: 1 };
  }

  public async lookup(parent: Node, name: string): Promise<RemoteNode | undefined> {
    const dir = this.assertDirectory(parent);
    if (!isValidName(name)) return undefined;
    const entry = (await this.listing(dir.path)).get(name);
    return entry && this.node(entry);
  }

  public async stat(node: Node): Promise<Stat> {
    const own = this.assertOwn(node);
    // The mount point describes itself: listing it just to report a size
    // would make a request for anyone who merely stats the directory.
    if (own.path === "/")
      return { kind: "directory", size: 0, createdAt: this.bootedAt, modifiedAt: this.bootedAt };
    if (own.pending)
      return { kind: "file", size: 0, createdAt: Date.now(), modifiedAt: Date.now() };

    const entry = await this.entryFor(own.path);
    if (!entry) throw enoent(own.path);
    return {
      kind: entry.kind,
      size: entry.size,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt,
    };
  }

  public async readdir(node: Node): Promise<string[]> {
    const dir = this.assertDirectory(node);
    return [...(await this.listing(dir.path)).keys()];
  }

  /** Whole-file GET. Returns the bytes and the version they are at. */
  private async fetchFile(path: string): Promise<{ data: Uint8Array; version: number }> {
    const response = await this.call("read", { path });
    const version = Number(response.headers.get("X-Fs-Version") ?? "0");
    return { data: new Uint8Array(await response.arrayBuffer()), version };
  }

  /**
   * Whole-file PUT. `baseVersion` is what the caller is willing to stand on:
   * 0 for a create, a version for a caller that read the file and means to
   * replace exactly that, and nothing at all for a plain overwrite. The last
   * one matters -- a caller that never read the file has no version to
   * assert, and asserting a remembered one would invent conflicts out of a
   * stale cache while still missing the real ones.
   */
  private async putFile(
    node: RemoteNode,
    data: Uint8Array,
    baseVersion: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (data.byteLength > MAX_FILE) throw efbig(node.path);
    const query: Record<string, string> = { path: node.path };
    if (node.pending) query.baseVersion = "0";
    else if (baseVersion !== null) query.baseVersion = String(baseVersion);
    // Copy into a buffer known not to be shared, which is what a body needs.
    const body = new Uint8Array(data.byteLength);
    body.set(data);

    const response = await this.call("write", query, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([body]),
      signal,
    });
    const { version } = (await response.json()) as { version: number };
    node.version = version;
    node.pending = false;
    this.invalidate(node.path);
  }

  public async read(node: Node, offset: number, length: number): Promise<Bytes> {
    const own = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);
    if (length < 0) throw einval(`Length cannot be negative: ${length}`);
    if (own.pending) return new Uint8Array(0);
    const { data } = await this.fetchFile(own.path);
    return data.slice(offset, offset + length);
  }

  public async write(node: Node, offset: number, data: Bytes): Promise<number> {
    const own = this.assertFile(node);
    if (offset < 0) throw einval(`Offset cannot be negative: ${offset}`);
    // Read first, so the version asserted below is one this call has seen.
    const seen = own.pending ? { data: new Uint8Array(0), version: 0 } : await this.fetchFile(own.path);
    const next = new Uint8Array(Math.max(seen.data.length, offset + data.length));
    next.set(seen.data);
    next.set(data, offset);
    await this.putFile(own, next, own.pending ? null : seen.version);
    return data.length;
  }

  public async truncate(node: Node, size: number): Promise<void> {
    const own = this.assertFile(node);
    if (size < 0) throw einval(`Size cannot be negative: ${size}`);
    // The VFS truncates to 0 just before opening for writing, so recording it
    // and letting the open file apply it keeps that to a single request.
    if (size === 0) {
      own.truncated = true;
      return;
    }
    const { data, version } = await this.fetchFile(own.path);
    const next = new Uint8Array(size);
    next.set(data.subarray(0, Math.min(size, data.length)));
    await this.putFile(own, next, version);
  }

  public async create(parent: Node, name: string, kind: NodeKind): Promise<RemoteNode> {
    const dir = this.assertDirectory(parent);
    if (!isValidName(name)) throw einval(name);
    if (kind !== "file" && kind !== "directory") throw einval(kind);

    const path = join(dir.path, name);
    if (kind === "directory") {
      await this.post("mkdir", { path });
      return { [BRAND]: true, kind: "directory", path, version: 1 };
    }
    // Held back until the first flush: see RemoteNode.pending.
    return { [BRAND]: true, kind: "file", path, version: 0, pending: true };
  }

  public async unlink(parent: Node, name: string): Promise<void> {
    const dir = this.assertDirectory(parent);
    const target = await this.lookup(dir, name);
    if (!target) throw enoent(name);
    if (target.kind === "directory") throw eisdir(name);
    await this.post("remove", { path: join(dir.path, name) });
  }

  public async rmdir(parent: Node, name: string): Promise<void> {
    const dir = this.assertDirectory(parent);
    const target = await this.lookup(dir, name);
    if (!target) throw enoent(name);
    if (target.kind !== "directory") throw enotdir(name);
    await this.post("remove", { path: join(dir.path, name) });
  }

  /** One server-side rekey, so a move never copies (which would briefly
   *  need room for both halves, and fail past half the quota). */
  public async rename(
    fromParent: Node,
    fromName: string,
    toParent: Node,
    toName: string,
  ): Promise<void> {
    const from = this.assertDirectory(fromParent);
    const to = this.assertDirectory(toParent);
    if (!isValidName(toName)) throw einval(toName);
    await this.post("move", { from: join(from.path, fromName), to: join(to.path, toName) });
  }

  public async open(node: Node, path: string): Promise<OpenFile> {
    return new RemoteFile(this, this.assertFile(node), path);
  }

  // Used by RemoteFile, which is the only thing that reads or writes bytes.
  /** @internal */ public load = (path: string) => this.fetchFile(path);
  /** @internal */ public save = (
    node: RemoteNode,
    data: Uint8Array,
    baseVersion: number | null,
    signal?: AbortSignal,
  ) => this.putFile(node, data, baseVersion, signal);

  // --------------------------------------------------------------- guards --

  private assertOwn(node: Node): RemoteNode {
    if (!(BRAND in node)) throw einval("node does not belong to remotefs");
    return node as RemoteNode;
  }

  private assertDirectory(node: Node): RemoteNode {
    const own = this.assertOwn(node);
    if (own.kind !== "directory") throw enotdir("node is not a directory");
    return own;
  }

  private assertFile(node: Node): RemoteNode {
    const own = this.assertOwn(node);
    if (own.kind !== "file") throw eisdir("node is not a file");
    return own;
  }
}

/**
 * One open file, buffered whole. The VFS reads in 64 KiB chunks and writes
 * wherever a caller seeks to, so going straight to the network per call would
 * turn one `cat` into a dozen requests -- and a chunked write would race its
 * own version check, each chunk rejecting the next.
 */
class RemoteFile implements OpenFile {
  public readonly seekable = true;

  private readonly fs: RemoteFS;
  private readonly node: RemoteNode;
  private readonly path: string;

  private buffer?: Uint8Array;
  private dirty = false;
  private closed = false;
  /** Whether this open read the file, and so has a version worth asserting. */
  private loaded = false;

  public constructor(fs: RemoteFS, node: RemoteNode, path: string) {
    this.fs = fs;
    this.node = node;
    this.path = path;
    // Nothing to fetch, and something to say even if no one writes: an
    // emptied or freshly created file must still reach the server.
    if (node.pending || node.truncated) {
      this.buffer = new Uint8Array(0);
      this.dirty = true;
      node.truncated = false;
    }
  }

  public get description(): string {
    return this.path;
  }

  private async load(): Promise<Uint8Array> {
    if (!this.buffer) {
      const { data, version } = await this.fs.load(this.node.path);
      this.node.version = version;
      this.buffer = data;
      this.loaded = true;
    }
    return this.buffer;
  }

  public async read(offset: number, length: number): Promise<Bytes> {
    this.assertOpen();
    const data = await this.load();
    return data.slice(offset, offset + length);
  }

  public async write(offset: number, data: Bytes): Promise<number> {
    this.assertOpen();
    const current = await this.load();
    const next = new Uint8Array(Math.max(current.length, offset + data.length));
    next.set(current);
    next.set(data, offset);
    this.buffer = next;
    this.dirty = true;
    return data.length;
  }

  public async stat(): Promise<Stat> {
    this.assertOpen();
    const size = this.dirty ? (this.buffer?.length ?? 0) : (await this.load()).length;
    return { kind: "file", size, createdAt: Date.now(), modifiedAt: Date.now() };
  }

  /**
   * The one write. Having read the file makes this a replacement of exactly
   * what was read, so a write that got in first is reported (EBUSY); a blind
   * overwrite asserts nothing and simply wins.
   */
  public async close(signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.dirty) return;
    const base = this.loaded ? this.node.version : null;
    await this.fs.save(this.node, this.buffer ?? new Uint8Array(0), base, signal);
  }

  private assertOpen(): void {
    if (this.closed) throw einval(`${this.path}: closed`);
  }
}
