// Shortcuts' Spotlight commands (utils/commands.ts), run headless in a worker:
// nothing here may touch the DOM.
//
//   search       the sites whose name or address has every word typed, from
//                every space
//   open <url>   open one of them in a new tab -- only an address that is
//                one of your shortcuts, whatever asks
//
// Read-only: the list is the app's (~/.config/shortcuts.json).
import type { AppInterface } from "../../kernel/syscalls/api";
import { commandMain, type CommandHandler, type SearchHandler } from "../../utils/commands";
import { ensureConfigDir } from "../../utils/settings";
import { hostOf, toUrl } from "./site";

interface Site {
  name: string;
  url: URL;
  space: string;
}

/** Every shortcut in the file, tolerating whatever shape it is in (the app cleans it; we only read). */
async function sites(os: AppInterface): Promise<Site[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await os.fs.readTextFile(`${await ensureConfigDir(os)}/shortcuts.json`));
  } catch {
    return [];
  }
  // The file used to be a plain list of shortcuts.
  const spaces: unknown[] = Array.isArray(raw)
    ? [{ name: "General", shortcuts: raw }]
    : Array.isArray((raw as { spaces?: unknown })?.spaces)
      ? (raw as { spaces: unknown[] }).spaces
      : [];
  return spaces.flatMap((space) => {
    const s = space as { name?: unknown; shortcuts?: unknown };
    const name = typeof s?.name === "string" ? s.name : "";
    return (Array.isArray(s?.shortcuts) ? s.shortcuts : []).flatMap((item: unknown): Site[] => {
      const shortcut = item as { name?: unknown; url?: unknown };
      const url = typeof shortcut?.url === "string" ? toUrl(shortcut.url) : null;
      const title = typeof shortcut?.name === "string" ? shortcut.name.trim() : "";
      return url ? [{ name: title || hostOf(url), url, space: name }] : [];
    });
  });
}

export const search: SearchHandler = async (os, query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  return (await sites(os))
    .filter((site) => {
      const text = `${site.name} ${hostOf(site.url)}`.toLowerCase();
      if (seen.has(site.url.href) || !words.every((word) => text.includes(word))) return false;
      seen.add(site.url.href);
      return true;
    })
    .slice(0, 5)
    .map((site) => ({
      title: site.name,
      detail: [hostOf(site.url), site.space].filter(Boolean).join(" · "),
      command: "open",
      input: site.url.href,
    }));
};

export const command: CommandHandler = async (os, id, input) => {
  if (id !== "open") return { error: `Shortcuts has no command "${id}".` };
  const site = (await sites(os)).find((each) => each.url.href === input);
  if (!site) return { error: "That shortcut is gone." };
  await os.shell.openExternal(site.url.href);
  return { message: `Opened ${site.name}` };
};

export const main = commandMain(command, search);
