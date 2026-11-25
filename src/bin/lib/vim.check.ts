// Self-check for vim.ts: `node src/bin/lib/vim.check.ts` (or `pnpm check`).
// Plain throws, no test framework; exits non-zero on the first failure.
import { Vim } from "./vim.ts";
import type { Effect } from "./vim.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const ESC = "\x1b";
const CTRL_R = "\x12";
/** Feeds keys one by one; "<Esc>"-style tokens are not needed, use the escapes above. */
function keys(vim: Vim, input: string): Effect[] {
  const effects: Effect[] = [];
  for (const k of input.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/gu) ?? []) {
    const effect = vim.feed(k);
    if (effect) effects.push(effect);
  }
  return effects;
}
const run = (text: string, input: string): Vim => {
  const vim = new Vim(text);
  keys(vim, input);
  return vim;
};
const text = (text: string, input: string): string[] => run(text, input).lines;

// loading and saving
eq(new Vim("a\nb\n").lines, ["a", "b"], "load: trailing newline is not a line");
eq(new Vim("").content(), "", "save: empty buffer is an empty file");
eq(new Vim("a\nb").content(), "a\nb\n", "save: always ends in a newline");

// insert mode
eq(text("", `ihello${ESC}`), ["hello"], "insert");
eq(text("ab", `Ax${ESC}`), ["abx"], "A appends");
eq(text("  ab", `Ix${ESC}`), ["  xab"], "I at first non-blank");
eq(text("ab", `ax${ESC}`), ["axb"], "a");
eq(text("a\nb", `ox${ESC}`), ["a", "x", "b"], "o");
eq(text("a\nb", `Ox${ESC}`), ["x", "a", "b"], "O");
eq(text("abcd", `lli\r${ESC}`), ["ab", "cd"], "Enter splits the line");
eq(text("ab\ncd", `ji\x7f${ESC}`), ["abcd"], "Backspace at line start joins");
eq(text("foo bar", `A baz\x17${ESC}`), ["foo bar "], "^W deletes a word");
eq(run("ab", `Ax${ESC}`).col, 2, "Esc steps back onto the last character");
eq(text("", `i\tx${ESC}`), ["  x"], "Tab is two spaces");

// motions
eq(run("one two three", "w").col, 4, "w");
eq(run("one two three", "2w").col, 8, "2w");
eq(run("one two three", "$b").col, 8, "b");
eq(run("one two three", "e").col, 2, "e");
eq(run("foo.bar baz", "w").col, 3, "w stops at punctuation");
eq(run("foo.bar baz", "W").col, 8, "W doesn't");
eq(run("a\n\nb", "w").row, 1, "w stops on an empty line");
eq(run("a\nb\nc", "G").row, 2, "G");
eq(run("a\nb\nc", "Ggg").row, 0, "gg");
eq(run("a\nb\nc", "2G").row, 1, "2G");
eq(run("  ab", "$^").col, 2, "^");
eq(run("abcabc", "fc").col, 2, "f");
eq(run("abcabc", "2fc").col, 5, "2f");
eq(run("abcabc", "tc").col, 1, "t");
eq(run("abcabc", "$Fa").col, 3, "F");
const wide = run("long line\nx\nlong line", "$jj");
eq(wide.col, 8, "j/k remember the wanted column");
eq(run("ab\n\ncd", "ljj").col, 1, "column survives a short line");

// operators
eq(text("one two", "dw"), ["two"], "dw");
eq(text("one two three", "d2w"), ["three"], "d2w");
eq(text("one two", "wdw"), ["one "], "dw on the last word keeps the line");
eq(text("one two", "cwxx" + ESC), ["xx two"], "cw");
eq(text("one two", "cwxx" + ESC + "w."), ["xx xx"], "dot repeats cw");
eq(text("a\nb\nc", "dd"), ["b", "c"], "dd");
eq(text("a\nb\nc", "2dd"), ["c"], "2dd");
eq(text("a\nb\nc", "dj"), ["c"], "dj is linewise");
eq(text("a", "dd"), [""], "dd on the only line");
eq(text("abc", "x"), ["bc"], "x");
eq(text("abc", "$x"), ["ab"], "x at the end");
eq(text("abc", "$X"), ["ac"], "X");
eq(text("abc def", "wD"), ["abc "], "D");
eq(text("abc def", "wCx" + ESC), ["abc x"], "C");
eq(text("abc", "sx" + ESC), ["xbc"], "s");
eq(text("abc\nd", "Sx" + ESC), ["x", "d"], "S");
eq(text("abc def", "d$"), [""], "d$");
eq(text("abc def", "wd0"), ["def"], "d0");
eq(text("a b", "d}"), [""], "d} to the end");
eq(text("a\nb\n\nc", "d}"), ["", "c"], "d} stops at the blank line");
eq(text("abc", "rx"), ["xbc"], "r");
eq(text("abc", "2rx"), ["xxc"], "2r");
eq(text("abc", "~~"), ["ABc"], "~");
eq(text("a\nb", "J"), ["a b"], "J");
eq(text("a\n  b\nc", "3J"), ["a b c"], "3J");
eq(text("ab", ">>"), ["  ab"], ">>");
eq(text("    ab", "<<"), ["  ab"], "<<");

// text objects
eq(text("foo bar baz", "wdiw"), ["foo  baz"], "diw");
eq(text("foo bar baz", "wdaw"), ["foo baz"], "daw");
eq(text("foo bar", "wdaw"), ["foo"], "daw at the end takes the blank before");
eq(text('say "hi there" now', 'fhci"x' + ESC), ['say "x" now'], 'ci"');
eq(text('say "hi there" now', 'fhda"'), ["say now"], 'da"');
eq(text("f(a, (b), c)", "fbdi("), ["f(a, (), c)"], "di( picks the innermost pair");
eq(text("f(a, (b), c)", "fadi("), ["f()"], "di( from the outer pair");
eq(text("{\n  a\n}", "jdi{"), ["{}"], "di{ across lines");
eq(text("x [a b] y", "fadi["), ["x [] y"], "di[");

// registers and paste
eq(text("a\nb", "ddp"), ["b", "a"], "dd p");
eq(text("a\nb", "yyjp"), ["a", "b", "a"], "yy p");
eq(text("a\nb", "yyP"), ["a", "a", "b"], "yy P");
eq(text("a\nb", "yy2p"), ["a", "a", "a", "b"], "2p linewise");
eq(text("abc", "xp"), ["bac"], "x p swaps");
eq(text("ab cd", "dwP"), ["ab cd"], "dw P");
eq(text("abc", "yl$p"), ["abca"], "yl p");
eq(text("one two", "yiwwP"), ["one onetwo"], "yiw P");

// visual mode
eq(text("hello world", "vld"), ["llo world"], "vld");
eq(text("hello world", "veyP"), ["hellohello world"], "v e y P");
eq(text("a\nb\nc", "Vjd"), ["c"], "Vjd");
eq(text("a\nb\nc", "Vjy" + "Gp"), ["a", "b", "c", "a", "b"], "V y p");
eq(text("abc", "vlU"), ["ABc"], "U");
eq(text("a\nb", "Vj>"), ["  a", "  b"], "V >");
eq(text("abc", "vlcx" + ESC), ["xc"], "v c");
eq(text("abc", "vlo" + "d"), ["c"], "o keeps the selection");
eq(run("abc", "v").mode, "visual", "v enters visual mode");
eq(run("abc", `v${ESC}`).mode, "normal", "Esc leaves it");

// undo and repeat
eq(text("a\nb\nc", "ddu"), ["a", "b", "c"], "u");
eq(text("a\nb\nc", "ddu" + CTRL_R), ["b", "c"], "^R");
eq(text("a", `ix${ESC}iy${ESC}u`), ["xa"], "an insert is one undo step");
eq(text("abc", "xxuu"), ["abc"], "two undos");
eq(text("abc", "u"), ["abc"], "nothing to undo");
eq(text("a b c d", "dw."), ["c d"], "dot repeats dw");
eq(text("a\nb\nc\nd", "dd."), ["c", "d"], "dot repeats dd");
eq(text("a\nb", `Ax${ESC}j.`), ["ax", "bx"], "dot repeats an insert");
eq(text("a\nb\nc", `ox${ESC}jj.`).length, 5, "dot repeats o");
eq(text("a\nb\nc\nd", "dd.u"), ["b", "c", "d"], "undo after dot undoes only the repeat");

// search
eq(run("a\nfoo\nb\nfoo", "/foo\r").row, 1, "/");
eq(run("a\nfoo\nb\nfoo", "/foo\rn").row, 3, "n");
eq(run("a\nfoo\nb\nfoo", "/foo\rnn").row, 1, "n wraps");
eq(run("a\nfoo\nb\nfoo", "/foo\rN").row, 3, "N wraps backwards");
eq(run("a\nfoo\nb\nfoo", "G?foo\r").row, 1, "?");
eq(run("a\nfoo\nb", "/zzz\r").message, "E486: Pattern not found: zzz", "no match says so");
eq(text("foo bar\nbar", "/bar\rx"), ["foo ar", "bar"], "x at a match");
eq(run("foo bar\nbaz foo", "*").row, 1, "* finds the next whole word");
eq(text("foo bar", "/bar\r0dn"), ["bar"], "dn deletes up to the next match");

// the command line
eq(keys(new Vim("a", "f.txt"), ":w\r"), [{ kind: "write", path: "f.txt", quit: false }], ":w");
eq(keys(new Vim("a"), ":w x.txt\r"), [{ kind: "write", path: "x.txt", quit: false }], ":w file");
eq(keys(new Vim("a", "f"), ":wq\r"), [{ kind: "write", path: "f", quit: true }], ":wq");
eq(keys(new Vim("a", "f"), "ZZ"), [{ kind: "write", path: "f", quit: true }], "ZZ");
eq(keys(new Vim("a", "f"), "ZQ"), [{ kind: "quit" }], "ZQ");
eq(keys(new Vim("a"), ":q\r"), [{ kind: "quit" }], ":q when clean");
const dirty = new Vim("a");
eq(keys(dirty, "x:q\r"), [], ":q refuses when modified");
eq(dirty.message.startsWith("E37"), true, ":q says why");
eq(keys(dirty, ":q!\r"), [{ kind: "quit" }], ":q!");
eq(dirty.modified, true, "modified after x");
dirty.wrote("f");
eq(dirty.modified, false, "wrote() cleans the buffer");
eq(keys(new Vim("a"), ":w\r"), [], ":w without a name does nothing");
eq(run("a\nb\nc", ":2\r").row, 1, ":2");
eq(run("a\nb\nc", ":$\r").row, 2, ":$");
eq(run("a\nb", ":9\r").row, 1, ":9 clamps");
eq(text("foo foo\nfoo", ":s/foo/bar/\r"), ["bar foo", "foo"], ":s once");
eq(text("foo foo\nfoo", ":s/foo/bar/g\r"), ["bar bar", "foo"], ":s/g");
eq(text("foo foo\nfoo", ":%s/foo/bar/g\r"), ["bar bar", "bar"], ":%s");
eq(text("a\nb\nc\nd", ":2,3s/./x/\r"), ["a", "x", "x", "d"], ":2,3s");
eq(text("abc", ":s/b/[&]/\r"), ["a[b]c"], ":s & is the match");
eq(text("a-b", ":s/(\\w)-(\\w)/\\2-\\1/\r"), ["b-a"], ":s group swap");
eq(text("a/b", ":s#/#-#\r"), ["a-b"], ":s with another delimiter");
eq(text("Foo", ":s/foo/x/i\r"), ["x"], ":s/i");
eq(text("a", ":s/a/b/\ru"), ["a"], "u undoes :s");
eq(run("abc", ":s/zzz/x/\r").message, "E486: Pattern not found: zzz", ":s without a match");
eq(run("a", ":bogus\r").message, "E492: Not an editor command: bogus", "unknown command");
eq(run("a", ":w").mode, "command", "the command line is a mode");
eq(run("a", `:x${ESC}`).mode, "normal", "Esc leaves it");
eq(run("a", ":\x7f").mode, "normal", "Backspace on an empty command line leaves it");

// drawing
const screen = (vim: Vim, rows = 5, cols = 20) => vim.render(rows, cols).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
eq(screen(new Vim("hello\nworld"), 5, 20).slice(0, 4), ["hello", "world", "~", "~"], "render: text and tildes");
eq(screen(new Vim("a"), 3, 20)[2]!.endsWith("1,1  All"), true, "render: ruler");
eq(new Vim("abc").render(4, 20).includes("\x1b[7ma\x1b[0m"), true, "render: the cursor is inverse");
const tabs = new Vim("\tx");
eq(screen(tabs, 3, 20)[0], "        x", "render: tabs are 8 wide");
const long = new Vim("0123456789".repeat(5));
keys(long, "$");
eq(screen(long, 3, 10)[0]!.length <= 10, true, "render: long lines scroll sideways");
eq(screen(long, 3, 10)[0]!.endsWith("9"), true, "render: the cursor stays in view");
const tall = new Vim(Array.from({ length: 50 }, (_, i) => String(i)).join("\n"));
keys(tall, "30G");
eq(screen(tall, 6, 20).includes("29"), true, "render: scrolls to the cursor");
eq(screen(new Vim("a"), 3, 20)[2]!.includes("-- INSERT --"), false, "render: no mode in normal mode");
const inserting = new Vim("a");
keys(inserting, "i");
eq(screen(inserting, 3, 40)[2]!.includes("-- INSERT --"), true, "render: INSERT shown");
const visual = new Vim("abc");
keys(visual, "vl");
eq(visual.render(3, 20).includes("\x1b[100m"), true, "render: selection is highlighted");
const numbered = new Vim("a\nb");
keys(numbered, ":set nu\r");
eq(screen(numbered, 4, 20).slice(0, 2), ["1 a", "2 b"], "render: :set nu");
const typing = new Vim("a");
keys(typing, ":wq");
eq(screen(typing, 3, 20)[2]!.startsWith(":wq"), true, "render: the command line");
eq(screen(new Vim("a"), 3, 20).every((l) => l.length <= 20), true, "render: never wider than the screen");

console.log(`vim: ${count} checks passed`);
