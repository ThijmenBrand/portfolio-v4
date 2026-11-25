// A reboot is a logout that also reloads the page: the session ends, the
// backend cookie is cleared (login's signOut, for the owner) and the kernel
// starts again from nothing.
//
// Whoever asks (taskbar, settings, the `reboot` command) leaves a marker and
// ends their own desktop, exactly like logging out. Login finds the marker
// once the session is gone and does the rest. The marker grants nothing: all
// it can cause is a reload after a logout the caller was already allowed to do.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ADMIN_GID } from "./users";

export const REBOOT_MARKER = "/tmp/.reboot";
const DESKTOP = "/System/desktop";

export type RebootKind = "restart" | "keep" | "reset";

/** Factory reset wipes every user's files, so it takes root or the admin group. */
export function mayFactoryReset(ids: { uid: number; gid: number }): boolean {
  return ids.uid === 0 || ids.gid === ADMIN_GID;
}

/**
 * Ends the caller's own session and asks login to reload the page afterwards.
 * "keep" leaves the saved window layout, so session reopens it (like macOS
 * "Reopen windows when logging back in"); "restart" forgets it. "reset" wipes
 * all local storage and starts as freshly installed.
 */
export async function reboot(os: AppInterface, kind: RebootKind = "restart"): Promise<void> {
  const ids = await os.process.ids();
  if (kind === "reset" && !mayFactoryReset(ids)) throw new Error("permission denied");
  // Login runs one desktop at a time, and not necessarily as the caller: after
  // `su root` the real uid is 0 while the session still belongs to its user.
  // Killing it is still checked by the kernel like any other kill.
  const desktop = (await os.process.list()).find(
    (proc) => proc.path === DESKTOP && proc.status === "running",
  );
  if (!desktop) throw new Error("no desktop session to reboot");
  await os.fs.writeTextFile(REBOOT_MARKER, kind);
  await os.process.kill(desktop.pid, "SIGTERM");
}

/**
 * Login's side: what was asked for (the marker is gone), or undefined if no
 * reboot. The marker is a file anyone can write, so a reset only counts when
 * its owner could have asked for one; otherwise it is only a restart.
 */
export async function takeRebootRequest(os: AppInterface): Promise<RebootKind | undefined> {
  const text = await os.fs.readTextFile(REBOOT_MARKER).catch(() => null);
  if (text === null) return undefined;
  const owner = await os.fs.stat(REBOOT_MARKER).catch(() => undefined);
  await os.fs.unlink(REBOOT_MARKER).catch(() => {});
  if (text === "keep") return "keep";
  if (text === "reset" && owner && mayFactoryReset({ uid: owner.uid, gid: owner.gid })) return "reset";
  return "restart";
}
