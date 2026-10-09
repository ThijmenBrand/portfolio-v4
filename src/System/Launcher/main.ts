// launcher — opens apps named in the page URL, then exits.
//
//   /                          → the default app (the resume)
//   /?launch=terminal          → just the terminal
//   /?launch=terminal,resume   → both, in that order (the last one gets focus)
//   /?launch=                  → nothing: a clean desktop
//
// A worker program like any other: no DOM, no privileges, everything over the
// wire. Started by the desktop at boot. It doesn't stay running — changing
// ?launch= in the address bar reloads the whole page, which boots us again.
import { registry } from "../../apps/registry";
import type { AppInterface } from "../../kernel/syscalls/api";

/** Opened when the URL doesn't say otherwise: the first thing a visitor sees. */
const DEFAULT_APPS = ["resume"];
/** A link can't open more than this many windows. */
const MAX_APPS = 5;

/**
 * The URL is untrusted input — whoever made the link chose it. So it can
 * only name launcher ids (the desktop's apps), never a path: ?launch=sh or
 * ?launch=/ProgramFiles/sh do nothing.
 */
function requestedApps(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get("launch");
  if (raw === null) return DEFAULT_APPS;

  const ids = raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  return [...new Set(ids)].slice(0, MAX_APPS);
}

export async function main(os: AppInterface): Promise<void> {
  const { search } = await os.shell.location();

  for (const id of requestedApps(search)) {
    const app = registry.find((entry) => entry.id === id);
    if (!app) {
      console.warn(`[launcher] ?launch=${id}: no such app`);
      continue;
    }
    try {
      await os.process.spawn(app.exec);
    } catch (error) {
      console.warn(`[launcher] could not open ${id}:`, error);
    }
  }

  await os.process.exit(0);
}
