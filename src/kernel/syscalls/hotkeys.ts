import { ebusy, einval, logError } from "../errors";
import type { KernelContext, Pid } from "../types";
import { requirePrivilege } from "./guards";

/**
 * System-wide hotkeys: a key the system hands to one privileged process,
 * wherever the keyboard is. Keys pressed in an app frame never reach our
 * document, so frame.ts forwards these and realm.ts calls pressHotkey.
 *
 *   palette   Cmd+K (Ctrl+K off a Mac)   Spotlight (src/System/Spotlight)
 */
export type Hotkey = "palette";

const HOTKEYS = new Set<unknown>(["palette"]);

/**
 * Cmd on a Mac, Ctrl elsewhere -- only that one, so a Mac terminal keeps
 * Ctrl+K (kill to the end of the line).
 */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The key event that means a hotkey, or null. Shared with frame.ts, which forwards it. */
export function hotkeyFor(event: KeyboardEvent): Hotkey | null {
  const mod = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (mod && !event.altKey && !event.shiftKey && event.code === "KeyK") return "palette";
  return null;
}

export const isHotkey = (value: unknown): value is Hotkey => HOTKEYS.has(value);

interface Claim {
  pid: Pid;
  onPress: () => void;
}

const claims = new WeakMap<KernelContext, Map<Hotkey, Claim>>();

function store(ctx: KernelContext): Map<Hotkey, Claim> {
  let map = claims.get(ctx);
  if (map) return map;
  claims.set(ctx, (map = new Map()));
  // Our own document: the desktop, the taskbar, or no window at all.
  document.addEventListener("keydown", (event) => {
    const name = hotkeyFor(event);
    if (!name || !map!.has(name)) return;
    event.preventDefault();
    pressHotkey(ctx, name);
  });
  return map;
}

/** One owner per hotkey, for as long as it runs (EBUSY for a second). */
export function claimHotkey(
  ctx: KernelContext,
  pid: Pid,
  name: unknown,
  onPress: () => void,
): void {
  requirePrivilege(ctx, pid, "display.claimHotkey");
  if (!isHotkey(name)) throw einval(`hotkey ${String(name)}`);
  if (typeof onPress !== "function") throw einval("onPress");
  const map = store(ctx);
  if (map.has(name)) throw ebusy(`hotkey ${name}`);

  map.set(name, { pid, onPress });
  ctx.processes.registerResource(pid, "hotkey", () => {
    if (map.get(name)?.pid === pid) map.delete(name);
  });
}

export function pressHotkey(ctx: KernelContext, name: Hotkey): void {
  const claim = claims.get(ctx)?.get(name);
  if (!claim) return;
  try {
    claim.onPress();
  } catch (error) {
    logError(error);
  }
}
