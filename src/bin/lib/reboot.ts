// What the UI needs to know about rebooting. The reboot itself is the kernel's
// (os.system.reboot); this only decides whether to offer a factory reset. The
// kernel makes the same call again, so hiding the item is cosmetic.
import { ADMIN_GID } from "./users";

/** Factory reset wipes every user's files, so it takes root or the admin group. */
export function mayFactoryReset(ids: { uid: number; gid: number }): boolean {
  return ids.uid === 0 || ids.gid === ADMIN_GID;
}
