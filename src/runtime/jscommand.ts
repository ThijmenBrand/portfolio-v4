import type { AppInterface } from "../kernel/syscalls/api";
import { readManifest } from "../utils/appfile";
import { runCommand, type CommandResult, type SearchResult } from "../utils/commands";
import { loadCommands, pipeConsole, type CommandModule } from "./jsload";

/**
 * `jscommand <file.app.js> <id> <input>`: run one of an installed app's
 * Spotlight commands, headless, in a worker. `jscommand <file> --search
 * <query>`: its search results. The app's `command` (and `search`) exports,
 * from its manifest's `handler` module or its entry, do the work; what they
 * return goes to stdout as one line of JSON (utils/commands.ts).
 */
export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [path, ...rest] = args;
  // stdout is the result line: the program's own logging goes to stderr.
  const flush = pipeConsole({
    io: { write: (_fd, data) => os.io.write(2, data as Uint8Array<ArrayBuffer>) },
  });

  let loaded: Promise<{ program: CommandModule; ids: Set<string>; search: boolean }> | undefined;
  const load = () =>
    (loaded ??= (async () => {
      if (!path) throw new Error("usage: jscommand <file.js> <id> [input]");
      const manifest = await readManifest((p) => os.fs.readFile(p), path);
      const program = await loadCommands((p) => os.fs.readTextFile(p), path, manifest?.handler);
      const ids = new Set((manifest?.commands ?? []).map((command) => command.id));
      return { program, ids, search: manifest?.search === true };
    })());

  await runCommand(os, rest, {
    command: async (id, input) => {
      const { program, ids } = await load();
      if (!ids.has(id)) throw new Error(`${path}: no command "${id}"`);
      const result = (await program.command(os, id, input)) as CommandResult | undefined;
      await flush();
      return typeof result === "object" && result !== null ? result : {};
    },
    search: async (query) => {
      const { program, search } = await load();
      if (!search || typeof program.search !== "function") return [];
      const results = (await program.search(os, query)) as SearchResult[] | undefined;
      await flush();
      return Array.isArray(results) ? results : [];
    },
  });
}
