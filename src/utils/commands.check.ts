// Self-check for commands.ts and the commands in appfile.ts manifests:
// `node --import ./scripts/ts-resolve.js src/utils/commands.check.ts` (or `pnpm check`).
//
// What it covers is what an app may declare or print, which Spotlight takes
// from files anyone can download: it must come out clean or not at all.
import type { AppInterface } from "../kernel/syscalls/api.ts";
import { formatManifest, parseManifest } from "./appfile.ts";
import { parseCommands, parseResult, parseSearch, runCommand } from "./commands.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

// ---- declarations
ok(parseCommands(undefined), [], "no commands");
ok(
  parseCommands([
    { id: "new", title: "  New note ", keywords: ["jot", 3, " "], input: { placeholder: "Text", required: true } },
    { id: "New", title: "Bad id" },
    { id: "x", title: "" },
    { id: "new", title: "Duplicate" },
    { id: "done", title: "Done", hidden: true, input: {} },
    "nonsense",
  ]),
  [
    { id: "new", title: "New note", keywords: ["jot"], input: { placeholder: "Text", required: true } },
    { id: "done", title: "Done", input: { placeholder: "Done" }, hidden: true },
  ],
  "bad entries are dropped, good ones cleaned",
);
ok(parseCommands(Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, title: "C" }))).length, 16, "at most 16");

// ---- the //@app manifest
const manifest = (raw: object) => parseManifest(formatManifest(raw as never));
ok(
  manifest({ name: "Notes", commands: [{ id: "new", title: "New note" }], handler: "./lib/commands.js", search: true }),
  { name: "Notes", commands: [{ id: "new", title: "New note" }], search: true, handler: "lib/commands.js" },
  "commands, a handler inside the folder, search",
);
ok(manifest({ commands: [{ id: "new", title: "N" }], handler: "../evil.js" })?.handler, undefined, "no handler outside the folder");
ok(manifest({ commands: [{ id: "new", title: "N" }], handler: "/home/x.js" })?.handler, undefined, "no absolute handler");
ok(manifest({ commands: [{ id: "new", title: "N" }], handler: "a/../../b.js" })?.handler, undefined, "no way up mid-path");
ok(manifest({ search: true })?.search, undefined, "search means nothing without commands");

// ---- what a handler prints
ok(parseResult('{"message":"Saved"}\n'), { message: "Saved" }, "a message");
ok(parseResult('log line\n{"error":"Nope"}'), { error: "Nope" }, "the JSON line, after other output");
ok(parseResult(""), { error: "That didn't work." }, "nothing printed is an error");
ok(parseResult('{"open":["a",1]}'), {}, "open must be strings");
ok(parseResult(`{"message":"${"x".repeat(500)}"}`).message?.length, 160, "long text is cut");
ok(
  parseSearch('{"results":[{"title":"Buy milk","detail":"today","command":"done","input":"ab12"},{"title":"No command"},{"title":"x","command":"Bad!"}]}'),
  [{ title: "Buy milk", command: "done", detail: "today", input: "ab12" }],
  "search results need a title and a command id",
);
ok(parseSearch("garbage"), [], "unreadable search: nothing");
ok(parseSearch(JSON.stringify({ results: Array.from({ length: 20 }, () => ({ title: "t", command: "c" })) })).length, 8, "at most 8 results");

// ---- the program body
{
  const written: string[] = [];
  let exitCode = -1;
  const os = {
    io: { write: async (_fd: number, data: Uint8Array) => void written.push(new TextDecoder().decode(data)) },
    process: { exit: async (code: number) => void (exitCode = code) },
  } as unknown as AppInterface;

  await runCommand(os, ["new", "hello"], { command: (id, input) => ({ message: `${id}:${input}` }) });
  ok([written.pop(), exitCode], ['{"message":"new:hello"}\n', 0], "a command's result, exit 0");
  await runCommand(os, ["new", ""], {
    command: () => {
      throw new Error("boom");
    },
  });
  ok([written.pop(), exitCode], ['{"error":"boom","results":[]}\n', 1], "a throw is an error, exit 1");
  await runCommand(os, ["--search", "mi"], { command: () => ({}), search: (q) => [{ title: q, command: "done" }] });
  ok(written.pop(), '{"results":[{"title":"mi","command":"done"}]}\n', "--search prints results");
  await runCommand(os, ["--search", "mi"], { command: () => ({}) });
  ok(written.pop(), '{"results":[]}\n', "no search handler: no results");
}

console.log(`commands: ${count} checks passed`);
