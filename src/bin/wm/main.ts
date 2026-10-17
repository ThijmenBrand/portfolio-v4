// wm — list and arrange windows, like wmctrl. `wm` lists them; `wm 3 left`
// snaps window 3 to the left half. Reaches the windows of every program
// running as you (the same reach as kill).
import type { AppInterface } from "../../kernel/syscalls/api";
import type { WindowId } from "../../kernel/types";
import { isTileZone, TILE_ZONES } from "../../kernel/windows/snap";
import { print } from "../lib/input";

const TARGETS = [...TILE_ZONES, "maximize", "restore"] as const;
const USAGE = `usage: wm [list]\n       wm <id> ${TARGETS.join("|")}\n`;

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [first, target] = args;

  if (first === undefined || first === "list") {
    const windows = await os.windows.list();
    const lines = [
      "   ID   PID  STATE         SIZE       TITLE",
      ...windows.map((win) => {
        const state = `${win.tile ?? win.state}${win.minimized ? " (min)" : ""}`;
        const size = `${win.frame.width}x${win.frame.height}`;
        const mark = win.focused ? "*" : " ";
        return `${mark}${String(win.windowId).padStart(4)} ${String(win.pid).padStart(5)}  ${state.padEnd(12)}  ${size.padEnd(9)}  ${win.title}`;
      }),
    ];
    await print(os, 1, `${lines.join("\n")}\n`);
    return os.process.exit(0);
  }

  const id = Number(first);
  const valid = isTileZone(target) || target === "maximize" || target === "restore";
  if (!/^\d+$/.test(first) || !valid || args.length !== 2) {
    await print(os, 2, USAGE);
    return os.process.exit(1);
  }

  try {
    await os.windows.tile(id as WindowId, target);
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    const reason =
      code === "EINVAL" ? "doesn't fit there" : code === "ENODEV" ? "no such window" : (code ?? message ?? "failed");
    await print(os, 2, `wm: ${first}: ${reason}\n`);
    return os.process.exit(1);
  }
  await os.process.exit(0);
}
