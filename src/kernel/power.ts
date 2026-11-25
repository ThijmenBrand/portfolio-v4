import type { VFS } from "./fs/vfs";
import type { Debounced } from "./fs/meta";

/**
 * restart: fresh start. keep: the same, but the saved window layout stays so
 * it reopens. reset: erase everything stored in this browser first.
 */
export type RebootKind = "restart" | "keep" | "reset";
export const REBOOT_KINDS: readonly RebootKind[] = ["restart", "keep", "reset"];

/**
 * What the kernel knows about shutting down. A reboot is requested by any
 * process (system.reboot), which ends the desktop session; login, the one
 * privileged process, then collects the request (system.takeReboot), ends the
 * backend session and reloads the page.
 */
export interface Power {
  /** The reboot asked for and not yet collected by login. */
  pending: RebootKind | undefined;
  /** Writes out what the kernel still holds in memory (system.sync). */
  sync(): Promise<void>;
  /** Wipes every byte this origin stores. Nothing is written back afterwards. */
  erase(): Promise<void>;
}

/** `saver` is the debounced owners-and-modes save, when storage is persistent. */
export function createPower(fs: VFS, saver: Debounced | undefined): Power {
  return {
    pending: undefined,
    sync: async () => {
      await saver?.flush();
    },
    erase: async () => {
      // The last save lands first, then nothing may write again: the owners
      // and modes file would otherwise come back after the wipe.
      await saver?.flush();
      saver?.cancel();
      fs.onAttrsChange = () => {};
      if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of root.keys()) names.push(name);
        for (const name of names) await root.removeEntry(name, { recursive: true });
      }
      localStorage.clear();
      sessionStorage.clear();
      for (const db of (await indexedDB.databases?.()) ?? []) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      for (const key of (await globalThis.caches?.keys()) ?? []) await caches.delete(key);
    },
  };
}
