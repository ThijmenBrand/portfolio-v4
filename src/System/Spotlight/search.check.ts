// Self-check for search.ts: `node src/System/Spotlight/search.check.ts` (or `pnpm check`).
import { rank, score } from "./search.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const items = [
  { title: "Terminal" },
  { title: "Todo" },
  { title: "New todo", also: ["add", "task", "Todo"] },
  { title: "Settings" },
  { title: "Task Manager" },
  { title: "notes.md — Code", also: ["Code"] },
];
const titles = (query: string) => rank(query, items).map((item) => item.title);

ok(titles("todo"), ["Todo", "New todo"], "the app itself before its command");
ok(titles("t").slice(0, 3), ["Terminal", "Todo", "Task Manager"], "a letter: what starts with it first, in order");
ok(titles("task"), ["Task Manager", "New todo"], "a keyword counts for less than a title");
ok(titles("new todo"), ["New todo"], "every word has to fit");
ok(titles("nt"), ["New todo"], "initials");
ok(titles("code"), ["notes.md — Code"], "a window by its app");
ok(titles("xyz"), [], "nothing");
ok(titles("  "), [], "an empty query finds nothing (Spotlight lists everything instead)");
ok(score("set", { title: "Settings" }) > score("set", { title: "Reset" }), true, "the start beats the middle");

console.log(`spotlight search: ${count} checks passed`);
