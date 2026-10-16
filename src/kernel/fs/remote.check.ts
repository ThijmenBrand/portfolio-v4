// Self-check for the rules guarding a remote (server-backed) mount:
// `node src/kernel/fs/remote.check.ts` (or `pnpm check`).
// Plain throws, no test framework; exits non-zero on the first failure.
//
// The driver here is a MemFS in disguise, so these test the VFS's rules and
// never the network. What matters is who is refused, and that refusing costs
// no request.
import { FdTable } from "../proc/fdTable.ts";
import { openFd, readFd, writeFd } from "../proc/fd.ts";
import type { Bytes, KernelContext, Pid, Process } from "../types.ts";
import { MemFS } from "./drivers/memfs.ts";
import type { FileSystemDriver } from "./fsdriver.ts";
import { ADMIN_GID, type Cred } from "./perm.ts";
import type { Node, NodeKind } from "./types.ts";
import { VFS } from "./vfs.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

async function refuses(run: () => Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`${what}\n  expected ${code}\n  actual   ${actual}`);
    count++;
    return;
  }
  throw new Error(`${what}\n  expected ${code}, but it succeeded`);
}

async function allows(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run();
    count++;
  } catch (error) {
    throw new Error(`${what}\n  expected success, got ${String(error)}`);
  }
}

/**
 * MemFS plus the two things a server-backed driver has: its own open(), and a
 * tally of how often it was asked to do anything. Reaching the driver at all
 * means a request would have gone out.
 */
class CountingFS implements FileSystemDriver {
  public calls = 0;
  private readonly inner = new MemFS();

  private count<T>(run: () => Promise<T>): Promise<T> {
    this.calls++;
    return run();
  }

  public root() {
    return this.count(() => this.inner.root());
  }
  public lookup(parent: Node, name: string) {
    return this.count(() => this.inner.lookup(parent, name));
  }
  public stat(node: Node) {
    return this.count(() => this.inner.stat(node));
  }
  public readdir(node: Node) {
    return this.count(() => this.inner.readdir(node));
  }
  public read(node: Node, offset: number, length: number) {
    return this.count(() => this.inner.read(node, offset, length));
  }
  public write(node: Node, offset: number, data: Bytes) {
    return this.count(() => this.inner.write(node, offset, data));
  }
  public truncate(node: Node, size: number) {
    return this.count(() => this.inner.truncate(node, size));
  }
  public create(parent: Node, name: string, kind: NodeKind) {
    return this.count(() => this.inner.create(parent, name, kind));
  }
  public rmdir(parent: Node, name: string) {
    return this.count(() => this.inner.rmdir(parent, name));
  }
  public unlink(parent: Node, name: string) {
    return this.count(() => this.inner.unlink(parent, name));
  }
  /** The branch VfsFile never takes: a driver that opens its own files. */
  public async open(node: Node, path: string) {
    const inner = this.inner;
    const self = this;
    return {
      description: path,
      seekable: true,
      async read(offset: number, length: number) {
        self.calls++;
        return inner.read(node, offset, length);
      },
      async write(offset: number, data: Bytes) {
        self.calls++;
        return inner.write(node, offset, data);
      },
      async stat() {
        return inner.stat(node);
      },
      async close() {},
    };
  }
}

const remote = new CountingFS();
const fs = new VFS();
fs.mount({ path: "/", driver: new MemFS(), readonly: false });
fs.mount({ path: "/mnt/cloud", driver: remote, readonly: false, remote: true });
await fs.mkdir("/mnt");
fs.setAttr("/mnt", { uid: 0, gid: 0, mode: 0o755 });

// The owner signed in, so the mount answers to their real uid and no other.
fs.setSessionUid(1000);

const owner: Cred = { uid: 1000, euid: 1000, gid: ADMIN_GID, untrusted: false };
const app: Cred = { uid: 1000, euid: 1000, gid: ADMIN_GID, untrusted: true }; // same person, VFS code
const guest: Cred = { uid: 1001, euid: 1001, gid: 1001, untrusted: false };
const text = new TextEncoder().encode("secret");

// --- the owner's own programs work ------------------------------------------
await allows(() => fs.mkdir("/mnt/cloud/app", owner), "owner: mkdir");
await allows(() => fs.writeFile("/mnt/cloud/app/notes", text, undefined, owner), "owner: write");
ok(
  new TextDecoder().decode(await fs.readFile("/mnt/cloud/app/notes", undefined, owner)),
  "secret",
  "owner: read back",
);
ok((await fs.readdir("/mnt/cloud", owner)).map((e) => e.name), ["app"], "owner: readdir");

// --- permissions are fixed, not stored --------------------------------------
const dir = await fs.stat("/mnt/cloud/app", owner);
ok([dir.uid, dir.gid, dir.mode.toString(8)], [0, ADMIN_GID, "770"], "directory mode is fixed");
const file = await fs.stat("/mnt/cloud/app/notes", owner);
ok([file.uid, file.gid, file.mode.toString(8)], [0, ADMIN_GID, "660"], "file mode is fixed");
// Nothing may write them down, so nothing can weaken them for the next boot.
fs.setAttr("/mnt/cloud/app/notes", { uid: 1000, gid: 1000, mode: 0o777 });
ok((await fs.stat("/mnt/cloud/app/notes", owner)).mode.toString(8), "660", "setAttr is ignored");
ok(
  Object.keys(fs.attrsUnder(["/mnt"])).filter((p) => p.startsWith("/mnt/cloud")),
  [],
  "nothing is stored for the mount",
);
await refuses(() => fs.chmod("/mnt/cloud/app/notes", 0o777, owner), "EPERM", "chmod is refused");
await refuses(() => fs.chown("/mnt/cloud/app/notes", 1000, 1000, owner), "EPERM", "chown is refused");

// --- a visitor is not in the admin group ------------------------------------
await refuses(() => fs.readdir("/mnt/cloud", guest), "EACCES", "guest: readdir");
await refuses(() => fs.readFile("/mnt/cloud/app/notes", undefined, guest), "EACCES", "guest: read");
await refuses(() => fs.writeFile("/mnt/cloud/app/x", text, undefined, guest), "EACCES", "guest: write");

// --- listing the directory above costs no request ---------------------------
remote.calls = 0;
const mnt = await fs.readdir("/mnt", guest);
ok(mnt.map((e) => e.name), ["cloud"], "the mount point is listed");
ok([mnt[0]!.gid, mnt[0]!.mode.toString(8)], [ADMIN_GID, "770"], "and describes itself");
ok(remote.calls, 0, "listing /mnt never reaches the server");

// --- code out of the filesystem is refused, whoever runs it -----------------
// Same uid and group as the owner above: only `untrusted` differs.
remote.calls = 0;
await refuses(() => fs.stat("/mnt/cloud/app/notes", app), "EACCES", "app: stat");
await refuses(() => fs.readdir("/mnt/cloud", app), "EACCES", "app: readdir");
await refuses(() => fs.readFile("/mnt/cloud/app/notes", undefined, app), "EACCES", "app: read");
await refuses(() => fs.writeFile("/mnt/cloud/app/notes", text, undefined, app), "EACCES", "app: write");
await refuses(() => fs.mkdir("/mnt/cloud/other", app), "EACCES", "app: mkdir");
await refuses(() => fs.unlink("/mnt/cloud/app/notes", app), "EACCES", "app: unlink");
await refuses(() => fs.rmdir("/mnt/cloud/app", app), "EACCES", "app: rmdir");
await refuses(() => fs.rename("/mnt/cloud/app", "/mnt/cloud/moved", app), "EACCES", "app: rename");
await refuses(() => fs.access("/mnt/cloud/app", app, 4), "EACCES", "app: access");
await refuses(() => fs.chmod("/mnt/cloud/app", 0o777, app), "EACCES", "app: chmod");
ok(remote.calls, 0, "a refused app never reaches the server");

// Even as root: `untrusted` is inherited by every child, but euid 0 is one
// setuid `su` away, so the check cannot sit behind the usual root shortcut.
const rootApp: Cred = { uid: 1000, euid: 0, gid: 0, untrusted: true };
await refuses(() => fs.readFile("/mnt/cloud/app/notes", undefined, rootApp), "EACCES", "app as root: read");
await refuses(() => fs.readdir("/mnt/cloud", rootApp), "EACCES", "app as root: readdir");

// --- root is not the same thing as the person who signed in ---------------
// The root password is public on purpose (bin/lib/users.ts), so euid 0 is
// three keystrokes away for any visitor. What it does not get them is the
// owner's session: `su` replaces the real uid, `sudo` keeps it.
const suRoot: Cred = { uid: 0, euid: 0, gid: 0, untrusted: false };
await refuses(() => fs.readFile("/mnt/cloud/app/notes", undefined, suRoot), "EACCES", "su root: read");
await refuses(() => fs.readdir("/mnt/cloud", suRoot), "EACCES", "su root: readdir");
await refuses(() => fs.writeFile("/mnt/cloud/app/x", text, undefined, suRoot), "EACCES", "su root: write");
ok(fs.mayList("/mnt/cloud", suRoot), false, "su root sees no events");

// sudo: root powers, but still started by the owner.
const sudo: Cred = { uid: 1000, euid: 0, gid: 0, untrusted: false };
await allows(() => fs.readFile("/mnt/cloud/app/notes", undefined, sudo), "sudo: reads");

// Another local user who happens to be in the admin group is still not them.
const otherAdmin: Cred = { uid: 1002, euid: 1002, gid: ADMIN_GID, untrusted: false };
await refuses(() => fs.readdir("/mnt/cloud", otherAdmin), "EACCES", "another admin user");

// Signed out: nobody at all, the owner included.
fs.setSessionUid(undefined);
await refuses(() => fs.readFile("/mnt/cloud/app/notes", undefined, owner), "EACCES", "signed out: read");
await refuses(() => fs.readdir("/mnt/cloud", owner), "EACCES", "signed out: readdir");
ok(fs.mayList("/mnt/cloud", owner), false, "signed out: no events");
// The kernel's own credential is not a way in either.
await refuses(() => fs.readdir("/mnt/cloud"), "EACCES", "signed out: not even root");
ok((await fs.readdir("/mnt", guest)).map((e) => e.name), ["cloud"], "the mount point still lists");
fs.setSessionUid(1000);
await allows(() => fs.readdir("/mnt/cloud", owner), "signed back in");

// Events carry path names, so they are filtered the same way.
ok(fs.mayList("/mnt/cloud", owner), true, "owner sees events");
ok(fs.mayList("/mnt/cloud", app), false, "an app sees none");
ok(fs.mayList("/mnt/cloud", guest), false, "a guest sees none");
ok(fs.mayList("/mnt", guest), true, "the directory above is ordinary");

// --- a driver's own open() still reports the write --------------------------
const changed: string[] = [];
fs.onChange = (path) => changed.push(path);
await fs.writeFile("/mnt/cloud/app/notes", new TextEncoder().encode("again"), undefined, owner);
ok(changed, ["/mnt/cloud/app/notes"], "a write through driver open() is announced");
fs.onChange = () => {};

// --- descriptors are checked on use, not only on open -----------------------
// The real path: a shell opens the file with its own credentials and hands
// the descriptor to a child it starts (`node evil.js < /mnt/cloud/...`).
const procs = new Map<Pid, Process>();
const ctx = { processes: { get: (pid: Pid) => procs.get(pid) }, fs } as unknown as KernelContext;
const proc = (pid: number, cred: Cred): Process =>
  ({
    pid: pid as Pid,
    cwd: "/",
    status: "running",
    files: new FdTable(),
    abortController: new AbortController(),
    log: "",
    ...cred,
  }) as unknown as Process;

const shell = proc(1, owner);
const child = proc(2, app);
procs.set(1 as Pid, shell);
procs.set(2 as Pid, child);

const fd = await openFd(ctx, 1 as Pid, "/mnt/cloud/app/notes", { read: true, write: true });
await allows(() => readFd(ctx, 1 as Pid, fd, 16), "shell: reads its own descriptor");
child.files.inheritFrom(shell.files); // what spawn does by default
await refuses(() => readFd(ctx, 2 as Pid, fd, 16), "EACCES", "inherited descriptor: read");
await refuses(() => writeFd(ctx, 2 as Pid, fd, text), "EACCES", "inherited descriptor: write");

// A local file passed the same way is nobody's business but the caller's.
await fs.writeFile("/home.txt", text);
const localFd = await openFd(ctx, 1 as Pid, "/home.txt", { read: true });
const after = proc(3, app);
procs.set(3 as Pid, after);
after.files.inheritFrom(shell.files);
await allows(() => readFd(ctx, 3 as Pid, localFd, 6), "local descriptors are unaffected");

console.log(`remote: ok (${count} checks)`);
