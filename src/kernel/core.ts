import { adminPaths, paths } from "./binfmt";
import { Display } from "./display/display";
import { EventBus } from "./events/bus";
import { MemFS } from "./fs/drivers/memfs";
import { opfsAvailable, OpfsFS } from "./fs/drivers/opfs";
import { ProcFS } from "./fs/drivers/procfs";
import { RemoteFS } from "./fs/drivers/remotefs";
import { debounce, loadMeta, migrateLegacyHome, saveMeta } from "./fs/meta";
import { basename, dirname } from "./fs/path";
import { ADMIN_GID } from "./fs/perm";
import { VFS } from "./fs/vfs";
import { KernelError } from "./errors";
import { faultProcess } from "./proc/faultproc";
import { ProcessManager } from "./proc/manager";
import { bindSyscalls, type SystemInterface } from "./syscalls/api";
import { createSyscallTable } from "./syscalls/table";
import type { KernelContext, Pid } from "./types";
import { defaultClose, forceClose } from "./windows/windowPolicy";
import { WindowManager } from "./windows/manager";
import { PortServer } from "./wire/server";

export function createKernel(screen: HTMLElement): {
  os: SystemInterface;
  boot(): Promise<void>;
} {
  const display = new Display(screen);
  const processes = new ProcessManager();
  const events = new EventBus();
  const fs = new VFS();

  fs.mount({
    path: "/",
    driver: new MemFS(),
    readonly: false,
  });
  fs.mount({
    path: "/proc",
    driver: new ProcFS({
      list: () => processes.list(),
      fds: (pid) => processes.get(pid)?.files.list() ?? [],
      env: (pid) => processes.get(pid)?.env ?? {},
      log: (pid) => processes.get(pid)?.log ?? "",
      mounts: () =>
        fs.listMounts().map(({ path, driver, readonly }) => ({
          path,
          readonly,
          // Not constructor.name: the build minifies it.
          type:
            driver instanceof OpfsFS
              ? "opfs"
              : driver instanceof ProcFS
                ? "proc"
                : driver instanceof RemoteFS
                  ? "remote"
                  : "mem",
        })),
    }),
    readonly: true,
  });

  const persistent = opfsAvailable();
  if (persistent) {
    fs.mount({ path: "/home", driver: new OpfsFS("home"), readonly: false });
    fs.mount({ path: "/etc", driver: new OpfsFS("etc"), readonly: false });
  }

  const windows = new WindowManager(
    display.getWindowLayer(),
    {
      defaultClose: (windowId, ownerPid) =>
        defaultClose(ctx, windowId, ownerPid),
      forceClose: (windowId, ownerPid) => forceClose(ctx, windowId, ownerPid),
      fault: (pid, error, site) => faultProcess(ctx, pid, error, site),
    },
    { emit: (event) => events.emit(event) },
    { get: () => display.workArea() },
  );

  fs.onChange = (path) => events.emit({ type: "fs.changed", path });

  display.onWorkAreaChange(() => {
    windows.reflowLayout();
    events.emit({ type: "display.workAreaChanged", area: display.workArea() });
  });

  const ctx: KernelContext = {
    processes,
    display,
    windows,
    events,
    fs,
    createOs: (pid) => bindSyscalls(table, pid),
    serve: (port, pid) =>
      new PortServer(port, pid, table, (message, code) =>
        faultProcess(
          ctx,
          pid,
          // Rebuild a KernelError so the fault record keeps its code,
          // exactly like a crash in an in-page app.
          code ? new KernelError(code, message) : new Error(message),
          "main",
        ),
      ),
  };

  const table = createSyscallTable(ctx);

  processes.allocate({
    parentPid: 0 as Pid,
    path: "/kernel",
    args: [],
    cwd: "/",
    env: { PATH: "/ProgramFiles", HOME: "/home/root", USER: "root" },
    privileged: true,
    uid: 0,
    euid: 0,
    gid: 0,
  });
  processes.setStatus(0 as Pid, "running");

  const os = bindSyscalls(table, 0 as Pid);
  events.on(
    ["process.spawned", "process.exited", "window.created", "window.destroyed"],
    (e) => console.log(e),
  );
  return {
    os,
    boot: async () => {
      await mountPrograms(fs);
      await fs.mkdir("/tmp");
      fs.setAttr("/tmp", { uid: 0, gid: 0, mode: 0o777 });
      // The owner's files on the server, the same in every browser. Mounted
      // whether or not anyone is signed in: its permissions are fixed and
      // admin-only (fs/perm.ts remoteAttr), and the backend checks the
      // session on every request, so an empty-handed visitor gets nowhere.
      await fs.mkdir("/mnt");
      fs.setAttr("/mnt", { uid: 0, gid: 0, mode: 0o755 });
      fs.mount({
        path: "/mnt/cloud",
        driver: new RemoteFS("/api/private/fs"),
        readonly: false,
        remote: true,
      });
      if (persistent) {
        await migrateLegacyHome("guest");
        fs.loadAttrs(await loadMeta());
        fs.onAttrsChange = debounce(
          () => saveMeta(fs.attrsUnder(["/home", "/etc"])),
          300,
        );
      } else {
        await fs.mkdir("/home");
        await fs.mkdir("/etc");
      }
      // System-wide startup programs, read by the desktop session (like
      // /etc/xdg/autostart or HKLM\...\Run). Per-user ones go in
      // ~/.config/autostart. One path per line, started in order.
      await fs.writeFile(
        "/etc/autostart",
        new TextEncoder().encode("/System/wallpaper\n/System/Taskbar\n/System/launcher\n"),
      );
      await os.process.spawn("/System/login");
    },
  };
}

/**
 * Make /ProgramFiles and /System listable, like /usr/bin: one empty,
 * read-only file per binfmt path. binfmt stays the source of truth for
 * exec; these files only exist so readdir (ls, tab completion) sees them.
 */
async function mountPrograms(fs: VFS): Promise<void> {
  const dirs = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    dirs.set(dir, [...(dirs.get(dir) ?? []), basename(path)]);
  }
  for (const [dir, names] of dirs) {
    const driver = new MemFS();
    const root = await driver.root();
    for (const name of names) await driver.create(root, name, "file");
    fs.mount({ path: dir, driver, readonly: true });
  }
  for (const path of paths) fs.setAttr(path, { uid: 0, gid: 0, mode: 0o755 });
  for (const path of adminPaths) {
    fs.setAttr(path, { uid: 0, gid: ADMIN_GID, mode: 0o750 });
  }
}
