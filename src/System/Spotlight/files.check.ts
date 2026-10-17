// Self-check for files.ts: `node src/System/Spotlight/files.check.ts` (or `pnpm check`).
import { affects, indexable, walk, where, type Listed } from "./files.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const file = (name: string): Listed => ({ name, kind: "file" });
const dir = (name: string): Listed => ({ name, kind: "directory" });

const tree: Record<string, Listed[]> = {
  "/home/ann": [dir("Documents"), dir(".config"), file("notes.md"), file("Terminal.app"), file(".profile")],
  "/home/ann/Documents": [file("report.pdf"), file("game.app.js"), dir("uni")],
  "/home/ann/Documents/uni": [file("essay.txt")],
  "/home/ann/.config": [file("settings.json")],
};
const readdir = async (path: string) => {
  const entries = tree[path];
  if (!entries) throw new Error("ENOENT");
  return entries;
};

ok(indexable(file("a.app")), false, "a .app shortcut is an app");
ok(indexable(file("a.app.js")), false, "so is a bundle");
ok(indexable(file("a.apps")), true, "but only that extension");
ok(indexable({ name: "pipe", kind: "fifo" }), false, "not a fifo");

const paths = async (limit?: number) => (await walk(readdir, "/home/ann", limit)).map((entry) => entry.path);
ok(
  await paths(),
  [
    "/home/ann/Documents",
    "/home/ann/notes.md",
    "/home/ann/Documents/report.pdf",
    "/home/ann/Documents/uni",
    "/home/ann/Documents/uni/essay.txt",
  ],
  "shallow first; no dotfiles, dot-folders or apps",
);
ok(await paths(2), ["/home/ann/Documents", "/home/ann/notes.md"], "the cap keeps the shallow ones");
ok(await walk(readdir, "/nowhere"), [], "an unreadable root is empty");

ok(affects("/home/ann", "/home/ann/Documents/x.txt"), true, "a change under home");
ok(affects("/home/ann", "/home/ann/.config/spotlight.json"), false, "not in a dot-folder");
ok(affects("/home/ann", "/home/anna/x.txt"), false, "not a neighbour's home");
ok(affects("/home/ann", "/tmp/x"), false, "not outside it");

ok(where("/home/ann", "/home/ann/notes.md"), "~", "home is ~");
ok(where("/home/ann", "/home/ann/Documents/uni/essay.txt"), "~/Documents/uni", "below it");

console.log(`spotlight files: ${count} checks passed`);
