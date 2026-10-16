// Self-check for the calendar's markup: `node scripts/calendar-dom.check.js`
// (or `pnpm check`).
//
// field()/action() in main.ts end in a non-null assertion, so a name with no
// matching element in calendar.html type-checks cleanly and then throws at the
// first property access. Inside openDetail that means clicking an event does
// nothing at all. tsc cannot see it and there is no DOM in `pnpm check`, so
// the markup and its lookups are matched as text instead.
//
// Lives here rather than beside the calendar because src/ is browser code and
// its tsconfig has no node types; this reads files from disk.
import { readFileSync } from "node:fs";

const app = new URL("../src/apps/calendar/", import.meta.url);
const read = (name) => readFileSync(new URL(name, app), "utf8");

const html = read("calendar.html");
const sources = [
  ["main.ts", read("main.ts")],
  ["views.ts", read("views.ts")],
];

const declared = (attribute) =>
  new Set([...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((m) => m[1]));

const names = { field: declared("data-field"), action: declared("data-action") };

let count = 0;
const missing = [];

for (const [file, source] of sources) {
  for (const helper of ["field", "action"]) {
    // Literal lookups only; the one interpolated name is covered below.
    for (const m of source.matchAll(new RegExp(`\\b${helper}\\("([^"]+)"\\)`, "g"))) {
      count++;
      if (!names[helper].has(m[1])) missing.push(`${file}: ${helper}("${m[1]}")`);
    }
  }
}

// action(`view-${view}`), over the three views main.ts iterates.
for (const view of ["month", "week", "agenda"]) {
  count++;
  if (!names.action.has(`view-${view}`)) missing.push(`main.ts: action(\`view-${view}\`)`);
}

if (missing.length) {
  throw new Error(`no such element in calendar.html:\n  ${missing.join("\n  ")}`);
}

// If the helpers stop reading these attributes, the scan above would quietly
// check nothing and pass.
const main = sources[0][1];
for (const needle of ['[data-field="${name}"]', '[data-action="${name}"]']) {
  if (!main.includes(needle)) {
    throw new Error(`main.ts no longer looks up ${needle}; this check is now blind`);
  }
}
count += 2;

// A <dialog> styled with an unconditional `display` never hides on close(),
// because any author declaration beats the UA's `dialog:not([open])` rule.
// Comments are stripped first: prose about dialogs would otherwise be read as
// part of the selector that follows it.
const css = read("calendar.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
  if (!/(^|[\s,])(dialog|\.detail)(?![\w-])/.test(selector)) continue;
  count++;
  if (/(^|;)\s*display\s*:/.test(body) && !/\[open\]/.test(selector) && !/display\s*:\s*none/.test(body)) {
    throw new Error(`\`${selector.trim()}\` sets display outside [open]; the dialog will not hide on close()`);
  }
}

console.log(`calendar/dom: ${count} checks passed`);
