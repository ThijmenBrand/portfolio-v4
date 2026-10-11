// Self-check for syntax.ts: `node src/bin/sh/syntax.check.ts` (or `pnpm check`).
// Plain throws, no test framework; exits non-zero on the first failure.
import {
  arith,
  escapeGlob,
  globToRegExp,
  hasGlob,
  Incomplete,
  lex,
  parse,
  unescapeGlob,
  type Simple,
  type Word,
} from "./syntax.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count += 1;
}
function throws(fn: () => unknown, kind: Function, what: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof kind) return void (count += 1);
    throw new Error(`${what}: threw ${String(error)}, wanted ${kind.name}`);
  }
  throw new Error(`${what}: did not throw`);
}

/** The words of the only simple command in `src`, as readable strings. */
function words(src: string): string[] {
  const cmd = parse(src).items[0]!.andOr.first.cmds[0] as Simple;
  return cmd.words.map(show);
}
const show = (word: Word) =>
  word
    .map((s) =>
      s.k === "lit" ? (s.q ? `'${s.v}'` : s.v) : s.k === "var" ? `$${s.name}${s.q ? "q" : ""}` : `${s.k}(${s.src})`,
    )
    .join("+");

// words and quoting
eq(words("echo a  b"), ["echo", "a", "b"], "split on blanks");
eq(words(`echo 'x $y' "a $b c"`), ["echo", "'x $y'", "'a '+$bq+' c'"], "quotes");
eq(words(`echo "" ''`), ["echo", "''", "''"], "empty quoted words survive");
eq(words("echo \\*"), ["echo", "'*'"], "backslash quotes");
eq(words("echo ~/x ~"), ["echo", "$HOMEq+/x", "$HOMEq"], "tilde");
eq(words("echo a~"), ["echo", "a~"], "tilde only at word start");
eq(words("echo $(ls -l | wc) $((1 + 2)) ${A}x $1$#"), ["echo", "cmd(ls -l | wc)", "arith(1 + 2)", "$A+x", "$1+$#"], "dollars");
eq(words('echo "$(echo ")")"'), ["echo", 'cmd(echo ")")'], "$( ) skips quoted parens");
eq(words("echo a#b # comment"), ["echo", "a#b"], "comments");
eq(words("echo $ a$"), ["echo", "$", "a$"], "lone $ is literal");

// operators and redirects
eq(
  lex("a>f 2>&1 >>g <h").map((t) => (t.t === "op" ? `${t.fd ?? ""}${t.v}` : t.raw)),
  ["a", ">", "f", "2>&", "1", ">>", "g", "<", "h"],
  "redirect tokens",
);
const redir = parse("cmd >out 2>&1 <in").items[0]!.andOr.first.cmds[0] as Simple;
eq(redir.redirects.map((r) => `${r.fd}${r.op}${show(r.target)}`), ["1>out", "2>&1", "0<in"], "redirects");
const assign = parse("A=1 B='x y' cmd C=2").items[0]!.andOr.first.cmds[0] as Simple;
eq(assign.assigns.map((a) => `${a.name}=${show(a.value)}`), ["A=1", "B='x y'"], "assignments");
eq(assign.words.map(show), ["cmd", "C=2"], "C=2 after the command is an argument");

const list = parse("a && b || c; d & e\nf");
eq(list.items.length, 4, "list items");
eq(list.items[0]!.andOr.rest.map((r) => r.op), ["&&", "||"], "and-or");
eq(list.items.map((i) => i.background), [false, true, false, false], "background");
eq(parse("! a | b | c").items[0]!.andOr.first.cmds.length, 3, "pipeline");
eq(parse("! a").items[0]!.andOr.first.bang, true, "bang");

// compound commands
const iff = parse("if a; then b; elif c\nthen d; else e; fi").items[0]!.andOr.first.cmds[0]!;
eq(iff.t === "if" && [iff.clauses.length, !!iff.otherwise], [2, true], "if/elif/else");
const loop = parse("while read l; do echo $l; done < file").items[0]!.andOr.first.cmds[0]!;
eq(loop.t === "while" && loop.redirects.length, 1, "while with redirect");
const forr = parse("for f in a *.js; do echo $f; done").items[0]!.andOr.first.cmds[0]!;
eq(forr.t === "for" && [forr.name, forr.words!.length], ["f", 2], "for in");
const forArgs = parse("for x\ndo echo; done").items[0]!.andOr.first.cmds[0]!;
eq(forArgs.t === "for" && forArgs.words, null, "for without in");
const fn = parse("greet() { echo hi $1; }").items[0]!.andOr.first.cmds[0]!;
eq(fn.t === "func" && [fn.name, fn.body.t], ["greet", "group"], "function");
eq(words("echo if then fi"), ["echo", "if", "then", "fi"], "keywords are words after a command");
eq(parse("{ a; b; } | c").items[0]!.andOr.first.cmds.map((c) => c.t), ["group", "simple"], "group in pipeline");

// incomplete input asks for more; real errors don't
for (const src of ["echo 'a", 'echo "a', "echo $(a", "if a; then b", "while a; do", "a |", "a &&", "for x in a; do", "f() {", "echo \\"]) {
  throws(() => parse(src), Incomplete, `incomplete: ${src}`);
}
for (const src of ["fi", "a | | b", "then", "( a )", "a && ;", "echo ${a-b}"]) {
  throws(() => parse(src), SyntaxError, `syntax error: ${src}`);
}
eq(parse("if a\nthen\n  b\nfi\n").items.length, 1, "multi-line if");

// arithmetic
const vars: Record<string, string> = { i: "4", empty: "" };
const calc = (e: string) => arith(e, (n) => vars[n] ?? "");
eq(calc("1 + 2 * 3"), 7, "precedence");
eq(calc("(1 + 2) * 3"), 9, "parens");
eq(calc("i + 1"), 5, "variables");
eq(calc("empty + missing"), 0, "unset is 0");
eq(calc("2 ** 3 ** 2"), 512, "power is right-assoc");
eq(calc("7 / 2 + 7 % 2"), 4, "integer division");
eq(calc("-i < 0 && !0"), 1, "unary, comparison, logic");
eq(calc("i == 4 || 0"), 1, "equality");
throws(() => calc("1 / 0"), Error, "division by zero");
throws(() => calc("1 +"), SyntaxError, "dangling operator");

// globs
eq(hasGlob("*.js"), true, "glob");
eq(hasGlob(escapeGlob("*.js")), false, "escaped glob");
eq(unescapeGlob(escapeGlob("a*[b]?")), "a*[b]?", "escape round trip");
eq(["a.js", "b.ts", "c.js", ".d.js"].filter((n) => globToRegExp("*.js").test(n)), ["a.js", "c.js", ".d.js"], "*.js");
eq(globToRegExp("[!a]?").test("bc"), true, "negated class");
eq(globToRegExp("[ab]x").test("ax"), true, "class");
eq(globToRegExp("a.b").test("axb"), false, ". is literal");
eq(globToRegExp("\\*").test("*"), true, "escaped star");

console.log(`syntax.check: ${count} checks passed`);
