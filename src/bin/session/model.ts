// What session remembers about the desktop, and the decisions made from it.
// Pure on purpose (no os, no DOM): model.check.ts runs it in node.
import type { ProcessInfo, Rect } from "../../kernel/types";
import { isTileZone, type TileZone } from "../../kernel/windows/snap.ts";
import type { WindowInfo } from "../../kernel/windows/types";

export interface SavedWindow {
  path: string;
  args: string[];
  /** The floating frame; for a maximized or tiled window, the one it returns to. */
  frame: Rect;
  state: "normal" | "maximized" | "tiled";
  tile?: TileZone;
  focused?: boolean;
}

/** A saved window that is open right now, so it can be arranged by id. */
export interface OpenWindow extends SavedWindow {
  windowId: number;
  /** Whose window it is, so a program the session doesn't want can be ended. */
  pid: number;
}

export const MAX_WINDOWS = 24;

/**
 * What a saved path may re-spawn. The file lives in the user's own home, so
 * it is trusted no more than the user is, but it is still only ever replayed
 * as the user -- and never for system programs, which autostart owns.
 */
export function restorable(path: string, home: string): boolean {
  return (
    path.startsWith("/ProgramFiles/") ||
    path === "/System/DebugPs" ||
    (home !== "/" && path.startsWith(`${home}/`))
  );
}

const keyOf = (path: string, args: readonly string[]): string => [path, ...args].join("\0");

/** The open windows as saved entries, oldest first, one per process. */
export function snapshot(
  windows: readonly WindowInfo[],
  processes: readonly ProcessInfo[],
  home: string,
): OpenWindow[] {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const seen = new Set<number>();
  const out: OpenWindow[] = [];
  for (const win of windows) {
    const proc = byPid.get(win.pid);
    if (!proc || seen.has(proc.pid)) continue;
    if (proc.status !== "running" && proc.status !== "loading") continue;
    if (!restorable(proc.path, home)) continue;
    seen.add(proc.pid);
    const floating = win.state === "normal" ? win.frame : (win.restoreFrame ?? win.frame);
    out.push({
      windowId: win.windowId,
      pid: proc.pid,
      path: proc.path,
      args: [...proc.args],
      frame: { ...floating },
      state: win.state,
      ...(win.state === "tiled" && win.tile && { tile: win.tile }),
      ...(win.focused && { focused: true as const }),
    });
  }
  return out.slice(-MAX_WINDOWS);
}

export interface Plan {
  /** Saved windows nothing has opened yet. The focused one is last, so it ends up on top. */
  reopen: SavedWindow[];
  /** Saved windows that are already open (autostart opened them): only move them. */
  adopt: Array<{ entry: SavedWindow; windowId: number }>;
  /** Open now, but not in the saved session: autostart's, which the session overrules. */
  extra: OpenWindow[];
}

/**
 * Match what was saved against what is open now. Whatever autostart already
 * opened (the same program and arguments) is adopted rather than opened a
 * second time, and still gets its saved place.
 */
export function plan(saved: readonly SavedWindow[], open: readonly OpenWindow[]): Plan {
  const have = new Map<string, number[]>();
  for (const win of open) {
    const key = keyOf(win.path, win.args);
    have.set(key, [...(have.get(key) ?? []), win.windowId]);
  }
  const unclaimed = new Set(open.map((win) => win.windowId));
  const reopen: SavedWindow[] = [];
  const adopt: Plan["adopt"] = [];
  for (const entry of saved) {
    const id = have.get(keyOf(entry.path, entry.args))?.shift();
    if (id === undefined) reopen.push(entry);
    else {
      adopt.push({ entry, windowId: id });
      unclaimed.delete(id);
    }
  }
  return {
    reopen: [...reopen.filter((entry) => !entry.focused), ...reopen.filter((entry) => entry.focused)],
    adopt,
    extra: open.filter((win) => unclaimed.has(win.windowId)),
  };
}

/** Keep a saved frame reachable on a screen that may be smaller than last time. */
export function fit(frame: Rect, area: Rect): Rect {
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  return {
    x: Math.min(Math.max(frame.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(frame.y, area.y), area.y + area.height - Math.min(height, 48)),
    width,
    height,
  };
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Is there a saved session at all? A file with no windows is one (everything
 * was closed); no file, or one that isn't ours, is not -- and then autostart
 * decides what opens, as on a first visit or after a reboot clears the file.
 */
export function hasSession(text: string | null): boolean {
  try {
    return Array.isArray((JSON.parse(text ?? "") as { windows?: unknown } | null)?.windows);
  } catch {
    return false;
  }
}

/** The file is hand-editable: keep what is well-formed, drop the rest. */
export function parseSession(text: string | null): SavedWindow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return [];
  }
  const list = (raw as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(list)) return [];
  const out: SavedWindow[] = [];
  for (const item of list) {
    const entry = item as Partial<SavedWindow> | null;
    const frame = entry?.frame;
    if (typeof entry?.path !== "string" || !entry.path.startsWith("/")) continue;
    if (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) continue;
    if (!frame || !num(frame.x) || !num(frame.y) || !num(frame.width) || !num(frame.height)) continue;
    const state =
      entry.state === "maximized" || entry.state === "tiled" ? entry.state : "normal";
    const tile = isTileZone(entry.tile) ? entry.tile : undefined;
    out.push({
      path: entry.path,
      args: entry.args,
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      state: state === "tiled" && !tile ? "normal" : state,
      ...(tile && state === "tiled" && { tile }),
      ...(entry.focused === true && { focused: true as const }),
    });
    if (out.length >= MAX_WINDOWS) break;
  }
  return out;
}

/** Only the saved fields: an open window's id means nothing next session. */
export const serialize = (windows: readonly SavedWindow[]): string =>
  `${JSON.stringify(
    {
      version: 1,
      windows: windows.map(({ path, args, frame, state, tile, focused }) => ({
        path,
        args,
        frame,
        state,
        ...(tile && { tile }),
        ...(focused && { focused }),
      })),
    },
    null,
    2,
  )}\n`;
