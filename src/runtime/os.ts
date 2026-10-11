import { logError } from "../kernel/errors";
import type { AppInterface } from "../kernel/syscalls/api";
import type { Pid, ProcessSignal, WindowId } from "../kernel/types";
import type { Member, WirePath } from "../kernel/wire/protocol";
import type { WireClient } from "./client";

type Args<P extends WirePath> =
  Member<P> extends (...args: infer A) => unknown ? A : never;
type Result<P extends WirePath> =
  Member<P> extends (...args: never[]) => infer R ? R : never;

/**
 * The out-of-realm `os` object: same AppInterface an in-page app gets from
 * bindSyscalls, but every kernel call goes over the wire.
 *
 * Typed against AppInterface, so a missing or misshapen member is a compile
 * error. Members marked LOCAL never reach the kernel (see RuntimeLocal in
 * protocol.ts).
 */
export function buildAppInterface(client: WireClient, pid: Pid): AppInterface {
  const call = <P extends WirePath>(path: P, ...args: Args<P>): Result<P> =>
    client.call(path, args) as unknown as Result<P>;

  const readFile = (path: string) => call("fs.readFile", path);
  const writeFile = (path: string, data: Uint8Array<ArrayBuffer>) =>
    call("fs.writeFile", path, data);

  return {
    display: {
      workArea: () => call("display.workArea"),
    },

    windows: {
      // Claims the window the kernel made at exec, then builds the handle
      // from its id. No `body`: the app owns its whole document instead.
      create: async (options) => {
        // The one call whose wire result differs from its AppInterface result:
        // the kernel answers with the claimed window's id, we build the handle.
        const id = (await client.call("windows.create", [options])) as WindowId;
        return {
          id,
          setTitle: (title) => call("windows.setTitle", id, title),
          close: () => call("windows.close", id),
          onCloseRequest: (callback) =>
            call("windows.onCloseRequest", id, callback),
        };
      },
      list: () => call("windows.list"),
      focus: (windowId) => call("windows.focus", windowId),
      setMinimized: (windowId, minimized) =>
        call("windows.setMinimized", windowId, minimized),
      setTitle: (windowId, title) => call("windows.setTitle", windowId, title),
      close: (windowId) => call("windows.close", windowId),
      onCloseRequest: (windowId, callback) =>
        call("windows.onCloseRequest", windowId, callback),
    },

    process: {
      get signal() {
        return client.abort.signal as unknown as ProcessSignal;
      },
      get pid() {
        return pid;
      },
      onSignal: (signal, handler) =>
        client.callWithDisposer("process.onSignal", [signal, handler]),
      wait: (child, options) => call("process.wait", child, options),
      spawn: (path, args, options) =>
        call("process.spawn", path, args, options),
      exit: (code) => call("process.exit", code ?? 0),
      list: () => call("process.list"),
      kill: (target, signal) => call("process.kill", target, signal),
      history: () => call("process.history"),
      chdir: (path) => call("process.chdir", path),
      cwd: () => call("process.cwd"),
      env: () => call("process.env"),
      setenv: (name, value) => call("process.setenv", name, value),
      ids: () => call("process.ids"),
      setsid: () => call("process.setsid"),
    },

    timers: {
      setInterval: async (callback, ms) =>
        setInterval(() => {
          try {
            callback();
          } catch (error) {
            logError(error);
          }
        }, ms),
      clearInterval: async (id) => clearInterval(id),
    },

    events: {
      subscribe: (types, handler) =>
        client.callWithDisposer("events.subscribe", [types, handler]),
    },

    shell: {
      openExternal: (url) => call("shell.openExternal", url),
      location: () => call("shell.location"),
      download: (path) => call("shell.download", path),
    },

    api: {
      fetch: (path, request) => call("api.fetch", path, request),
    },

    net: {
      fetch: (url, request) => call("net.fetch", url, request),
    },

    dialog: {
      open: (options) => call("dialog.open", options),
    },

    fs: {
      readFile,
      writeFile,
      readTextFile: async (path) =>
        new TextDecoder().decode(await readFile(path)),
      writeTextFile: (path, text) =>
        writeFile(path, new TextEncoder().encode(text)),
      readdir: (path) => call("fs.readdir", path),
      stat: (path) => call("fs.stat", path),
      mkdir: (path) => call("fs.mkdir", path),
      unlink: (path) => call("fs.unlink", path),
      rename: (from, to) => call("fs.rename", from, to),
      rmdir: (path) => call("fs.rmdir", path),
      chmod: (path, mode) => call("fs.chmod", path, mode),
      chown: (path, uid, gid) => call("fs.chown", path, uid, gid),
    },

    io: {
      open: (path, flags) => call("io.open", path, flags),
      close: (fd) => call("io.close", fd),
      read: (fd, length) => call("io.read", fd, length),
      write: (fd, data) => call("io.write", fd, data),
      seek: (fd, offset, whence) =>
        call("io.seek", fd, offset, whence ?? "set"),
      dup: (fd, to) => call("io.dup", fd, to),
      fstat: (fd) => call("io.fstat", fd),
      listFds: () => call("io.listFds"),
      pipe: () => call("io.pipe"),
      openpty: () => call("io.openpty"),
      tcgetattr: (fd) => call("io.tcgetattr", fd),
      tcsetattr: (fd, changes) => call("io.tcsetattr", fd, changes),
      tcgetpgrp: (fd) => call("io.tcgetpgrp", fd),
      tcsetpgrp: (fd, pgid) => call("io.tcsetpgrp", fd, pgid),
      getWinsize: (fd) => call("io.getWinsize", fd),
      setWinsize: (fd, size) => call("io.setWinsize", fd, size),
    },
  };
}
