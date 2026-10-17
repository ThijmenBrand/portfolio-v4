// Self-check for the Projects app's markup: `node scripts/projects-dom.check.js`
// (or `pnpm check`). The same idea as todo-dom.check.js: field() and action()
// end in a non-null assertion, so a name with no element in projects.html
// type-checks and then throws at first use. Most of the app is built in code;
// these are the fixed points it hangs off.
import { readFileSync } from "node:fs";

const app = new URL("../src/apps/projects/", import.meta.url);
const html = readFileSync(new URL("projects.html", app), "utf8");
const main = readFileSync(new URL("main.ts", app), "utf8");

const declared = (attribute) =>
  new Set([...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((m) => m[1]));
const names = { field: declared("data-field"), action: declared("data-action") };

let count = 0;
const missing = [];
for (const helper of ["field", "action"]) {
  for (const m of main.matchAll(new RegExp(`\\b${helper}(?:<[^>]+>)?\\("([^"]+)"\\)`, "g"))) {
    count++;
    if (!names[helper].has(m[1])) missing.push(`main.ts: ${helper}("${m[1]}")`);
  }
}
if (missing.length) throw new Error(`no such element in projects.html:\n  ${missing.join("\n  ")}`);
if (count < 6) throw new Error(`only ${count} lookups found in main.ts; this check is now blind`);

console.log(`projects markup: ${count} lookups resolved`);
