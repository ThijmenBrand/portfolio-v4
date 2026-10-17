// Self-check for the Todo app's markup: `node scripts/todo-dom.check.js`
// (or `pnpm check`). The same idea as calendar-dom.check.js: field() and
// action() end in a non-null assertion, so a name with no element in
// todo.html type-checks and then throws at first use.
import { readFileSync } from "node:fs";

const app = new URL("../src/apps/todo/", import.meta.url);
const html = readFileSync(new URL("todo.html", app), "utf8");
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
for (const id of [...main.matchAll(/clone\("([^"]+)"\)/g)].map((m) => m[1])) {
  count++;
  if (!html.includes(`<template id="${id}">`)) missing.push(`main.ts: clone("${id}")`);
}
if (missing.length) throw new Error(`no such element in todo.html:\n  ${missing.join("\n  ")}`);
if (count < 10) throw new Error(`only ${count} lookups found in main.ts; this check is now blind`);

console.log(`todo markup: ${count} lookups resolved`);
