// Self-check for diff.ts, sed.ts and ustar.ts: `node src/bin/lib/tools.check.ts` (or `pnpm check`).
// Plain throws, no test framework; exits non-zero on the first failure.
import { diffLines, normal, unified } from "./diff.ts";
import { compile, run } from "./sed.ts";
import { pack, unpack } from "./ustar.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

// diff
const a = ["a", "b", "c", "d"];
const b = ["a", "x", "c", "d", "e"];
eq(normal(diffLines(a, a)), "", "diff: equal");
eq(normal(diffLines(a, b)), "2c2\n< b\n---\n> x\n4a5\n> e\n", "diff: normal");
eq(unified(diffLines(a, b), 1), "@@ -1,4 +1,5 @@\n a\n-b\n+x\n c\n d\n+e\n", "diff: unified, merged hunk");
eq(normal(diffLines(["a"], [])), "1d0\n< a\n", "diff: delete all");
eq(unified(diffLines([], ["a"])), "@@ -0,0 +1,1 @@\n+a\n", "diff: unified from empty");
const long = Array.from({ length: 20 }, (_, i) => String(i));
const changed = long.map((l, i) => (i === 2 || i === 17 ? `${l}!` : l));
eq(unified(diffLines(long, changed), 1).match(/@@/g)?.length, 4, "diff: far changes, two hunks");

// sed
const sed = (script: string, input: string[], quiet = false) => run(compile(script), input, quiet);
eq(sed("s/o/0/", ["foo", "bar"]), ["f0o", "bar"], "sed: s once");
eq(sed("s/o/0/g", ["foo"]), ["f00"], "sed: s global");
eq(sed("s/(\\w+) (\\w+)/\\2 \\1/", ["hello world"]), ["world hello"], "sed: groups");
eq(sed("s/x/[&]/", ["axb"]), ["a[x]b"], "sed: &");
eq(sed("s|/|_|g", ["a/b/c"]), ["a_b_c"], "sed: other delimiter");
eq(sed("2,3p", ["1", "2", "3", "4"], true), ["2", "3"], "sed: -n range");
eq(sed("/b/d", ["a", "b", "c"]), ["a", "c"], "sed: regex delete");
eq(sed("$d", ["a", "b"]), ["a"], "sed: last line");
eq(sed("2q", ["a", "b", "c"]), ["a", "b"], "sed: quit");
eq(sed("/start/,/end/d", ["a", "start", "x", "end", "b"]), ["a", "b"], "sed: regex range");
eq(sed("s/a/b/; s/b/c/", ["a"]), ["c"], "sed: two commands");
eq(sed("s/a/A/p", ["a", "z"], true), ["A"], "sed: s///p with -n");
eq(sed("s/a/$1/", ["a"]), ["$1"], "sed: literal $");

// ustar
const enc = new TextEncoder();
const deep = `${"d".repeat(80)}/${"e".repeat(80)}/file.txt`;
const entries = [
  { path: "proj", kind: "directory" as const, mode: 0o755, mtime: 1_700_000_000_000, data: new Uint8Array(0) },
  { path: "proj/main.js", kind: "file" as const, mode: 0o644, mtime: 1_700_000_000_000, data: enc.encode("x".repeat(600)) },
  { path: deep, kind: "file" as const, mode: 0o600, mtime: 0, data: enc.encode("") },
];
const archive = pack(entries);
eq(archive.length % 512, 0, "tar: block aligned");
eq(unpack(archive), entries.map((e) => ({ path: e.path, mode: e.mode, mtime: e.mtime, kind: e.kind, data: e.data })), "tar: round trip");
const evil = pack([{ path: "../x", kind: "file", mode: 0o644, mtime: 0, data: enc.encode("no") }, { path: "/etc/y", kind: "file", mode: 0o644, mtime: 0, data: enc.encode("ok") }]);
eq(unpack(evil).map((e) => e.path), ["etc/y"], "tar: no escaping the target dir");

console.log(`tools.check: ${count} passed`);
