// App commands: the actions an app offers in Spotlight (Cmd+K), such as
// "New todo".
//
// An app declares them as data, so Spotlight can list them without running
// anything: built-in apps in their app.ts manifest (`commands`), installed
// ones in their //@app manifest (utils/appfile.ts). Running one is running a
// program, headless, as the user:
//
//   built-in    /ProgramFiles/<app>.commands <id> <input>
//               src/apps/<app>/commands.ts, a worker (binfmt)
//   installed   /ProgramFiles/jscommand <file.app.js> <id> <input>
//               the app's `command` export, from its `handler` module (or
//               its entry), in a worker (runtime/jscommand.ts)
//
// Either way the handler is `command(os, id, input)`, and what it returns is
// written to stdout as one line of JSON, which Spotlight reads from a pipe.
// No new power: the handler can do exactly what the app itself could.
//
// An app can also answer searches (`search: true` in its manifest): while
// something is typed, Spotlight runs the same program with `--search <query>`
// and the app's `search(os, query)` returns results, each of which runs one
// of its commands with an input chosen by the app ("buy milk" runs Todo's
// `done` with that todo's id).
//
// Everything here may come from a file the user downloaded, so it is all
// validated, and Spotlight only ever shows it as text.
import type { AppInterface } from "../kernel/syscalls/api";

export interface CommandSpec {
  /** Stable within the app: what the handler is called with. [a-z0-9-], at most 32. */
  id: string;
  /** What Spotlight shows, e.g. "New todo". */
  title: string;
  /** More words it is found by ("add", "task"). */
  keywords?: string[];
  /** Asks for text first: Spotlight's field becomes this command's input. */
  input?: { placeholder: string; required?: boolean };
  /** Not listed on its own: only search results run it (e.g. Todo's `done <id>`). */
  hidden?: boolean;
}

/** One thing an app found for a query. Choosing it runs `command` with `input`. */
export interface SearchResult {
  title: string;
  /** Said beside it, quieter ("tomorrow 14:00", "github.com"). */
  detail?: string;
  command: string;
  input?: string;
}

export interface CommandResult {
  /** Said in Spotlight before it closes ("Added “Milk” · no plan"). */
  message?: string;
  /** Said instead, and Spotlight stays open to try again. */
  error?: string;
  /** Start the app with these arguments afterwards (e.g. to show what was made). */
  open?: string[];
}

export type CommandHandler = (
  os: AppInterface,
  id: string,
  input: string,
) => CommandResult | Promise<CommandResult>;

export type SearchHandler = (
  os: AppInterface,
  query: string,
) => SearchResult[] | Promise<SearchResult[]>;

export const MAX_COMMANDS = 16;
export const MAX_INPUT = 500;
export const MAX_RESULTS = 8;
/** argv[0] that asks for search results rather than a command. */
export const SEARCH_FLAG = "--search";

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** A manifest's `commands`, cleaned up: bad entries are dropped, not fatal. */
export function parseCommands(raw: unknown): CommandSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandSpec[] = [];
  for (const item of raw.slice(0, MAX_COMMANDS)) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const title = text(c.title, 64);
    if (typeof c.id !== "string" || !ID.test(c.id) || !title) continue;
    if (out.some((other) => other.id === c.id)) continue;
    const spec: CommandSpec = { id: c.id, title };
    if (Array.isArray(c.keywords)) {
      const keywords = c.keywords.slice(0, 10).flatMap((k) => text(k, 32) ?? []);
      if (keywords.length) spec.keywords = keywords;
    }
    const input = c.input as Record<string, unknown> | undefined;
    if (typeof input === "object" && input !== null) {
      spec.input = { placeholder: text(input.placeholder, 80) ?? title };
      if (input.required === true) spec.input.required = true;
    }
    if (c.hidden === true) spec.hidden = true;
    out.push(spec);
  }
  return out;
}

/** What a handler printed, cleaned up. Anything unreadable is an error. */
export function parseResult(output: string): CommandResult {
  const line = output.split("\n").find((l) => l.trim().startsWith("{"));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return { error: "That didn't work." };
  }
  if (typeof raw !== "object" || raw === null) return { error: "That didn't work." };
  const result: CommandResult = {};
  const message = text(raw.message, 160);
  const error = text(raw.error, 160);
  if (message) result.message = message;
  if (error) result.error = error;
  if (Array.isArray(raw.open) && raw.open.length <= 8 && raw.open.every((a) => typeof a === "string")) {
    result.open = (raw.open as string[]).map((a) => a.slice(0, 1024));
  }
  return result;
}

/** What a search printed, cleaned up: at most MAX_RESULTS, each naming a command. */
export function parseSearch(output: string): SearchResult[] {
  const line = output.split("\n").find((l) => l.trim().startsWith("{"));
  let raw: { results?: unknown };
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return [];
  }
  if (!Array.isArray(raw?.results)) return [];
  return raw.results.slice(0, MAX_RESULTS).flatMap((item: unknown): SearchResult[] => {
    if (typeof item !== "object" || item === null) return [];
    const r = item as Record<string, unknown>;
    const title = text(r.title, 120);
    if (!title || typeof r.command !== "string" || !ID.test(r.command)) return [];
    const result: SearchResult = { title, command: r.command };
    const detail = text(r.detail, 80);
    if (detail) result.detail = detail;
    if (typeof r.input === "string") result.input = r.input.slice(0, MAX_INPUT);
    return [result];
  });
}

export interface Handlers {
  command: (id: string, input: string) => CommandResult | Promise<CommandResult>;
  search?: (query: string) => SearchResult[] | Promise<SearchResult[]>;
}

/**
 * The body of a command program. `<id> <input>`: run the command and print
 * its result as one JSON line (a throw is an `error`). `--search <query>`:
 * print `{"results": [...]}`. Then exit.
 */
export async function runCommand(os: AppInterface, args: string[], handlers: Handlers): Promise<void> {
  const [first = "", input = ""] = args;
  let output: object;
  let failed = false;
  try {
    if (first === SEARCH_FLAG) {
      const results = handlers.search ? await handlers.search(input.slice(0, MAX_INPUT)) : [];
      output = { results: Array.isArray(results) ? results.slice(0, MAX_RESULTS) : [] };
    } else {
      output = (await handlers.command(first, input.slice(0, MAX_INPUT))) ?? {};
      failed = Boolean((output as CommandResult).error);
    }
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error), results: [] };
    failed = true;
  }
  await os.io.write(1, new TextEncoder().encode(`${JSON.stringify(output)}\n`)).catch(() => {});
  await os.process.exit(failed ? 1 : 0);
}

/** A built-in app's commands.ts: `export const main = commandMain(command, search)`. */
export const commandMain =
  (command: CommandHandler, search?: SearchHandler) =>
  (os: AppInterface, args: string[]): Promise<void> =>
    runCommand(os, args, {
      command: (id, input) => command(os, id, input),
      search: search && ((query) => search(os, query)),
    });
