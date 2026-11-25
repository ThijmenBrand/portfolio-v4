// vim — the editing engine behind `vim`. Keys go in, a screenful of text comes out.
// Pure (no os, no DOM), so vim.check.ts can drive it in plain Node. See `man vim`.
//
// Keys are what a terminal sends: "a", "\x1b" (Esc), "\r", "\x1b[A" (Up), "\x12" (^R).

export type Mode = "normal" | "insert" | "visual" | "vline" | "command" | "search";
/** What the host has to do for us: files are its business, not the engine's. */
export type Effect = { kind: "write"; path: string; quit: boolean } | { kind: "quit" };

interface Pos {
  row: number;
  col: number;
}
/** Where a motion lands. `inclusive`: the character there is part of the range. */
interface Target extends Pos {
  linewise: boolean;
  inclusive: boolean;
}
/** `b` is exclusive; a linewise range covers whole rows a.row..b.row. */
interface Range {
  a: Pos;
  b: Pos;
  linewise: boolean;
}
interface Register {
  lines: string[];
  linewise: boolean;
}
interface Snapshot {
  lines: string[];
  row: number;
  col: number;
}
/** One parsed normal/visual command: [count][operator][count]key[arg]. */
interface Cmd {
  count?: number;
  op?: string;
  key: string;
  arg?: string;
}

const SHIFT = "  ";
const OPERATORS = "dcy<>";
const MOTIONS = new Set(["h", "l", "j", "k", "w", "W", "b", "B", "e", "E", "0", "^", "$", "G", "gg", "f", "t", "F", "T", "n", "N", "{", "}"]);
const NEEDS_ARG = new Set(["f", "t", "F", "T", "r"]);
const NORMAL = new Set(["x", "X", "D", "C", "s", "S", "Y", "p", "P", "u", "\x12", "i", "a", "I", "A", "o", "O", "r", "J", "~", ".", "v", "V", ":", "/", "?", "ZZ", "ZQ", "\x04", "\x15", "\x06", "\x02", "*"]);
const VISUAL = new Set(["d", "x", "y", "c", "s", "~", "u", "U", "o", "v", "V", "<", ">"]);
/** Escape sequences that mean the same as a plain key in normal mode. */
const ALIASES: Record<string, string> = {
  "\x1b[A": "k",
  "\x1b[B": "j",
  "\x1b[C": "l",
  "\x1b[D": "h",
  "\x1b[H": "0",
  "\x1b[F": "$",
  "\x1b[3~": "x",
  "\x1b[5~": "\x02",
  "\x1b[6~": "\x06",
};
const BRACKETS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

/** 0 blank, 1 word, 2 punctuation (WORD motions: everything non-blank is 1). */
function cls(ch: string | undefined, big: boolean): number {
  if (ch === undefined || /\s/.test(ch)) return 0;
  return big || /\w/.test(ch) ? 1 : 2;
}

function firstNonBlank(line: string): number {
  const i = line.search(/\S/);
  return i < 0 ? Math.max(0, line.length - 1) : i;
}

function before(a: Pos, b: Pos): boolean {
  return a.row < b.row || (a.row === b.row && a.col < b.col);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toggleCase(text: string): string {
  return [...text].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
}

function compile(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegExp(pattern), flags);
  }
}

/** vim's `\1` and `&` in a :s replacement, as JavaScript's `$1` and `$&`. */
function replacement(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "\\" && next !== undefined) {
      out += /\d/.test(next) ? `$${next}` : next === "&" ? "&" : next === "n" ? "\n" : next === "$" ? "$$" : next;
      i++;
    } else if (ch === "&") out += "$&";
    else if (ch === "$") out += "$$";
    else out += ch;
  }
  return out;
}

export class Vim {
  public lines: string[];
  public row = 0;
  public col = 0;
  public mode: Mode = "normal";
  public name?: string;
  /** Shown on the bottom line until the next key. */
  public message = "";

  private wantCol = 0;
  private top = 0;
  private left = 0;
  private rows = 24;
  private number = false;

  private pend = "";
  private cmd = "";
  private searchBack = false;
  private search?: { re: RegExp; back: boolean; text: string };
  private anchor: Pos = { row: 0, col: 0 };
  private register?: Register;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private saved: string;

  private keyLog: string[] = [];
  private lastChange: string[] = [];
  private changing = false;
  private replaying = false;

  public constructor(text: string, name?: string) {
    const all = text.split("\n");
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    this.lines = all;
    this.name = name;
    this.saved = this.lines.join("\n");
  }

  // ---- host interface -----------------------------------------------------

  /** What `:w` should put on disk. */
  public content(): string {
    return this.lines.length === 1 && this.lines[0] === "" ? "" : `${this.lines.join("\n")}\n`;
  }

  /** The host wrote the file (`path`); the buffer is clean again. */
  public wrote(path: string): void {
    this.name ??= path;
    this.saved = this.lines.join("\n");
    this.message = `"${path}" ${this.lines.length}L, ${new TextEncoder().encode(this.content()).length}B written`;
  }

  public get modified(): boolean {
    return this.lines.join("\n") !== this.saved;
  }

  public feed(key: string): Effect | undefined {
    this.message = "";
    if (!this.replaying) {
      if (this.mode === "normal" && this.pend === "") this.keyLog = [];
      this.keyLog.push(key);
    }
    const effect = this.dispatch(key) ?? undefined;
    this.clamp();
    if (!this.replaying && this.changing && this.mode === "normal" && this.pend === "") {
      this.lastChange = this.keyLog;
      this.changing = false;
    }
    return effect;
  }

  private dispatch(key: string): Effect | void {
    switch (this.mode) {
      case "insert":
        return void this.insert(key);
      case "command":
      case "search":
        return this.cmdline(key);
      default:
        return this.command(key);
    }
  }

  // ---- normal and visual mode -------------------------------------------

  private command(raw: string): Effect | void {
    const visual = this.mode !== "normal";
    let key = raw.startsWith("\x1b") && raw.length > 1 ? (ALIASES[raw] ?? "") : raw;
    if (this.pend === "") key = key === " " ? "l" : key === "\x7f" ? "h" : key;
    if (key === "\x1b" || key === "\x03") {
      this.pend = "";
      if (visual) this.mode = "normal";
      return;
    }
    if (key === "" || key.length > 1) return; // a sequence we don't know, or a pair of UTF-16 units

    this.pend += key;
    const parsed = this.parse(this.pend, visual);
    if (parsed === "more") return;
    this.pend = "";
    if (parsed === "bad") return;
    return visual ? this.visualCommand(parsed) : this.normalCommand(parsed);
  }

  private parse(buf: string, visual: boolean): Cmd | "more" | "bad" {
    let i = 0;
    const number = (): number | undefined => {
      const m = /^[1-9][0-9]*/.exec(buf.slice(i));
      if (m) i += m[0].length;
      return m ? Number(m[0]) : undefined;
    };
    const first = number();
    if (i >= buf.length) return "more";
    let op: string | undefined;
    let second: number | undefined;
    if (!visual && OPERATORS.includes(buf[i]!)) {
      op = buf[i++]!;
      second = number();
      if (i >= buf.length) return "more";
    }
    let key = buf[i++]!;
    const count = first === undefined && second === undefined ? undefined : (first ?? 1) * (second ?? 1);

    if (op && (key === "i" || key === "a")) {
      if (i >= buf.length) return "more";
      return { count, op, key: "object", arg: key + buf[i] };
    }
    if (key === "g" || key === "Z") {
      if (i >= buf.length) return "more";
      key += buf[i++];
    }
    if (op && key === op) key = "line";
    let arg: string | undefined;
    if (NEEDS_ARG.has(key)) {
      if (i >= buf.length) return "more";
      arg = buf[i++];
    }
    const known =
      key === "line"
        ? true
        : op
          ? MOTIONS.has(key)
          : MOTIONS.has(key) || (visual ? VISUAL : NORMAL).has(key);
    return known ? { count, op, key, arg } : "bad";
  }

  private normalCommand(c: Cmd): Effect | void {
    if (c.op) return void this.operate(c);
    if (MOTIONS.has(c.key)) return void this.move(c);

    const line = this.lines[this.row]!;
    switch (c.key) {
      case "x":
        return void this.operate({ op: "d", key: "l", count: c.count });
      case "X":
        return void this.operate({ op: "d", key: "h", count: c.count });
      case "D":
        return void this.operate({ op: "d", key: "$", count: c.count });
      case "C":
        return void this.operate({ op: "c", key: "$", count: c.count });
      case "S":
        return void this.operate({ op: "c", key: "line", count: c.count });
      case "Y":
        return void this.operate({ op: "y", key: "line", count: c.count });
      case "s":
        if (line === "") return this.startInsert();
        return void this.operate({ op: "c", key: "l", count: c.count });
      case "p":
      case "P":
        return this.paste(c.key === "P", c.count ?? 1);
      case "u":
        return this.undo();
      case "\x12":
        return this.redo();
      case "i":
        return this.startInsert();
      case "a":
        if (line !== "") this.col++;
        return this.startInsert();
      case "I":
        this.col = line.search(/\S/) < 0 ? line.length : line.search(/\S/);
        return this.startInsert();
      case "A":
        this.col = line.length;
        return this.startInsert();
      case "o":
      case "O": {
        this.change();
        const at = c.key === "o" ? this.row + 1 : this.row;
        this.lines.splice(at, 0, "");
        this.row = at;
        this.col = 0;
        this.mode = "insert";
        return;
      }
      case "r": {
        const n = c.count ?? 1;
        if (!c.arg || c.arg < " " || this.col + n > line.length) return;
        this.change();
        this.lines[this.row] = line.slice(0, this.col) + c.arg.repeat(n) + line.slice(this.col + n);
        this.col += n - 1;
        return;
      }
      case "J":
        return this.join(Math.max(2, c.count ?? 2));
      case "~": {
        if (line === "") return;
        this.change();
        const n = Math.min(c.count ?? 1, line.length - this.col);
        this.lines[this.row] = line.slice(0, this.col) + toggleCase(line.slice(this.col, this.col + n)) + line.slice(this.col + n);
        this.col += n;
        return;
      }
      case ".":
        return this.repeat();
      case "v":
      case "V":
        this.anchor = { row: this.row, col: this.col };
        this.mode = c.key === "v" ? "visual" : "vline";
        return;
      case ":":
        this.mode = "command";
        this.cmd = "";
        return;
      case "/":
      case "?":
        this.mode = "search";
        this.searchBack = c.key === "?";
        this.cmd = "";
        return;
      case "*":
        return this.starSearch();
      case "ZZ":
        return this.name ? { kind: "write", path: this.name, quit: true } : void (this.message = "E32: No file name");
      case "ZQ":
        return { kind: "quit" };
      case "\x04":
      case "\x15":
      case "\x06":
      case "\x02": {
        const page = c.key === "\x04" || c.key === "\x15" ? Math.max(1, (this.rows - 1) >> 1) : Math.max(1, this.rows - 3);
        const by = c.key === "\x04" || c.key === "\x06" ? page : -page;
        this.top = Math.min(Math.max(0, this.top + by), this.lines.length - 1);
        this.row = Math.min(Math.max(0, this.row + by), this.lines.length - 1);
        this.col = this.colFor(this.row);
        return;
      }
    }
  }

  private visualCommand(c: Cmd): void {
    if (MOTIONS.has(c.key)) return this.move(c);
    const linewise = this.mode === "vline";
    const range = this.toRange(this.anchor, { row: this.row, col: this.col, linewise, inclusive: true });
    if (!range) return;

    switch (c.key) {
      case "o":
        [this.anchor, this.row, this.col] = [{ row: this.row, col: this.col }, this.anchor.row, this.anchor.col];
        return;
      case "v":
        this.mode = linewise ? "visual" : "normal";
        return;
      case "V":
        this.mode = linewise ? "normal" : "vline";
        return;
      case "y":
        this.mode = "normal";
        return this.apply("y", range);
      case "d":
      case "x":
        this.change(false);
        this.mode = "normal";
        return this.apply("d", range);
      case "c":
      case "s":
        this.change(false);
        this.mode = "normal";
        return this.apply("c", range);
      case "<":
      case ">":
        this.change(false);
        this.mode = "normal";
        return this.apply(c.key, range);
      case "~":
      case "u":
      case "U": {
        this.change(false);
        this.mode = "normal";
        const fn = c.key === "~" ? toggleCase : c.key === "u" ? (s: string) => s.toLowerCase() : (s: string) => s.toUpperCase();
        for (let r = range.a.row; r <= range.b.row; r++) {
          const line = this.lines[r]!;
          const from = !range.linewise && r === range.a.row ? range.a.col : 0;
          const to = !range.linewise && r === range.b.row ? range.b.col : line.length;
          this.lines[r] = line.slice(0, from) + fn(line.slice(from, to)) + line.slice(to);
        }
        this.row = range.a.row;
        this.col = range.linewise ? this.col : range.a.col;
        return;
      }
    }
  }

  /** A plain cursor motion. */
  private move(c: Cmd): void {
    const t = this.motion(c.key, c.count, c.arg, false);
    if (!t) return;
    this.row = t.row;
    this.col = Math.min(t.col, Math.max(0, this.lines[t.row]!.length - 1));
    if (c.key === "$") this.wantCol = Infinity;
    else if (c.key !== "j" && c.key !== "k") this.wantCol = this.col;
  }

  /** `d`, `c`, `y`, `<`, `>` followed by a motion, a text object or itself. */
  private operate(c: Cmd): void {
    const op = c.op!;
    const start = { row: this.row, col: this.col };
    let range: Range | null;

    if (c.key === "object") {
      range = this.object(c.arg!, start);
    } else if (c.key === "line") {
      const last = Math.min(this.lines.length - 1, this.row + (c.count ?? 1) - 1);
      range = { a: { row: this.row, col: 0 }, b: { row: last, col: this.lines[last]!.length }, linewise: true };
    } else {
      // `cw` on a word changes up to its end, like `ce` — not up to the next word.
      const onWord = /\S/.test(this.lines[this.row]![this.col] ?? "");
      const target =
        op === "c" && (c.key === "w" || c.key === "W") && onWord
          ? this.changeWord(c.key === "W", c.count ?? 1)
          : this.motion(c.key, c.count, c.arg, true);
      range = target && this.toRange(start, target);
    }
    if (!range) return;
    if (op !== "y") this.change();
    this.apply(op, range);
  }

  private changeWord(big: boolean, count: number): Target {
    const line = this.lines[this.row]!;
    const k = cls(line[this.col], big);
    let end = this.col;
    while (end + 1 < line.length && cls(line[end + 1], big) === k) end++;
    let pos: Pos = { row: this.row, col: end };
    for (let i = 1; i < count; i++) pos = this.wordEnd(pos, big);
    return { ...pos, linewise: false, inclusive: true };
  }

  private toRange(start: Pos, t: Target): Range | null {
    const later = before(t, start) ? start : t;
    const earlier = later === t ? start : t;
    if (t.linewise) {
      return { a: { row: earlier.row, col: 0 }, b: { row: later.row, col: this.lines[later.row]!.length }, linewise: true };
    }
    let end: Pos = { row: later.row, col: Math.min(this.lines[later.row]!.length, later.col + (t.inclusive ? 1 : 0)) };
    // An exclusive motion ending in column 0 stops at the end of the line before; if it
    // started at or before the first non-blank, the whole lines go (`d}` from a paragraph's top).
    if (!t.inclusive && end.col === 0 && end.row > earlier.row) {
      end = { row: end.row - 1, col: this.lines[end.row - 1]!.length };
      if (earlier.col <= firstNonBlank(this.lines[earlier.row]!)) {
        return { a: { row: earlier.row, col: 0 }, b: end, linewise: true };
      }
    }
    return { a: earlier, b: end, linewise: false };
  }

  private apply(op: string, r: Range): void {
    const rows = r.b.row - r.a.row + 1;
    if (op === "<" || op === ">") {
      for (let i = r.a.row; i <= r.b.row; i++) {
        const line = this.lines[i]!;
        if (op === ">") this.lines[i] = line === "" ? line : SHIFT + line;
        else this.lines[i] = line.replace(/^(\t| {1,2})/, "");
      }
      this.row = r.a.row;
      this.col = firstNonBlank(this.lines[this.row]!);
      this.wantCol = this.col;
      return;
    }

    this.register = {
      linewise: r.linewise,
      lines: r.linewise
        ? this.lines.slice(r.a.row, r.b.row + 1)
        : r.a.row === r.b.row
          ? [this.lines[r.a.row]!.slice(r.a.col, r.b.col)]
          : [this.lines[r.a.row]!.slice(r.a.col), ...this.lines.slice(r.a.row + 1, r.b.row), this.lines[r.b.row]!.slice(0, r.b.col)],
    };

    if (op === "y") {
      if (rows > 2) this.message = `${rows} lines yanked`;
      this.row = r.a.row;
      this.col = r.linewise ? this.colFor(r.a.row) : r.a.col;
      return;
    }

    if (r.linewise) {
      if (op === "c") {
        this.lines.splice(r.a.row, rows, "");
        this.mode = "insert";
        this.col = 0;
      } else {
        this.lines.splice(r.a.row, rows);
        if (this.lines.length === 0) this.lines.push("");
        this.row = Math.min(r.a.row, this.lines.length - 1);
        this.col = firstNonBlank(this.lines[this.row]!);
        if (rows > 2) this.message = `${rows} fewer lines`;
      }
      this.row = Math.min(r.a.row, this.lines.length - 1);
    } else {
      const head = this.lines[r.a.row]!.slice(0, r.a.col);
      const tail = this.lines[r.b.row]!.slice(r.b.col);
      this.lines.splice(r.a.row, rows, head + tail);
      this.row = r.a.row;
      this.col = r.a.col;
      if (op === "c") this.mode = "insert";
    }
    this.wantCol = this.col;
  }

  private paste(before: boolean, count: number): void {
    const reg = this.register;
    if (!reg) return void (this.message = 'E353: Nothing in register "');
    this.change();
    if (reg.linewise) {
      const block = Array.from({ length: count }, () => reg.lines).flat();
      const at = before ? this.row : this.row + 1;
      this.lines.splice(at, 0, ...block);
      this.row = at;
      this.col = firstNonBlank(this.lines[at]!);
    } else {
      const line = this.lines[this.row]!;
      const at = before || line === "" ? this.col : this.col + 1;
      const parts = reg.lines.join("\n").repeat(count).split("\n");
      const head = line.slice(0, at);
      const tail = line.slice(at);
      if (parts.length === 1) {
        this.lines[this.row] = head + parts[0] + tail;
        this.col = at + parts[0]!.length - 1;
      } else {
        this.lines.splice(this.row, 1, head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail);
        this.col = at;
      }
    }
    this.wantCol = this.col;
  }

  private join(count: number): void {
    if (this.row + 1 >= this.lines.length) return;
    this.change();
    for (let i = 1; i < count && this.row + 1 < this.lines.length; i++) {
      const a = this.lines[this.row]!;
      const b = this.lines[this.row + 1]!.trimStart();
      const glue = a === "" || b === "" || /\s$/.test(a) || b.startsWith(")") ? "" : " ";
      this.col = a.length + (glue ? 0 : -1);
      this.lines.splice(this.row, 2, a + glue + b);
    }
    this.col = Math.max(0, this.col);
    this.wantCol = this.col;
  }

  private repeat(): void {
    if (this.lastChange.length === 0) return;
    this.replaying = true;
    try {
      for (const key of this.lastChange) this.feed(key);
      if (this.mode !== "normal") this.feed("\x1b");
    } finally {
      this.replaying = false;
    }
  }

  // ---- undo ---------------------------------------------------------------

  /** Called before every change; an insert session is one change. */
  private change(track = true): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    if (track && !this.replaying) this.changing = true;
  }

  private snapshot(): Snapshot {
    return { lines: [...this.lines], row: this.row, col: this.col };
  }

  private same(s: Snapshot): boolean {
    return s.lines.length === this.lines.length && s.lines.every((l, i) => l === this.lines[i]);
  }

  private undo(): void {
    let s = this.undoStack.pop();
    while (s && this.same(s)) s = this.undoStack.pop(); // a change that changed nothing
    if (!s) return void (this.message = "Already at oldest change");
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  private redo(): void {
    let s = this.redoStack.pop();
    while (s && this.same(s)) s = this.redoStack.pop();
    if (!s) return void (this.message = "Already at newest change");
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  private restore(s: Snapshot): void {
    this.lines = s.lines;
    this.row = s.row;
    this.col = s.col;
    this.wantCol = s.col;
  }

  // ---- motions ------------------------------------------------------------

  private colFor(row: number): number {
    return Math.min(this.wantCol, Math.max(0, this.lines[row]!.length - 1));
  }

  private motion(key: string, n: number | undefined, arg: string | undefined, op: boolean): Target | null {
    const count = n ?? 1;
    const { row, col } = this;
    const line = this.lines[row]!;
    const last = this.lines.length - 1;
    const to = (p: Pos, inclusive = false, linewise = false): Target => ({ ...p, inclusive, linewise });
    const clampRow = (r: number) => Math.min(last, Math.max(0, r));

    switch (key) {
      case "h":
        return col === 0 ? null : to({ row, col: Math.max(0, col - count) });
      case "l": {
        const max = op ? line.length : Math.max(0, line.length - 1);
        return col >= max ? null : to({ row, col: Math.min(max, col + count) });
      }
      case "j":
      case "k": {
        const r = clampRow(row + (key === "j" ? count : -count));
        return r === row ? null : to({ row: r, col: this.colFor(r) }, false, true);
      }
      case "0":
        return to({ row, col: 0 });
      case "^":
        return to({ row, col: firstNonBlank(line) });
      case "$": {
        const r = clampRow(row + count - 1);
        return to({ row: r, col: Math.max(0, this.lines[r]!.length - 1) }, true);
      }
      case "G":
      case "gg": {
        const r = n === undefined ? (key === "G" ? last : 0) : clampRow(n - 1);
        return to({ row: r, col: firstNonBlank(this.lines[r]!) }, false, true);
      }
      case "w":
      case "W": {
        let p: Pos = { row, col };
        for (let i = 0; i < count; i++) {
          const next = this.wordForward(p, key === "W");
          // `dw` stops at the end of its line instead of eating the line break.
          p = op && i === count - 1 && next.row > p.row ? { row: p.row, col: this.lines[p.row]!.length } : next;
        }
        return to(p);
      }
      case "e":
      case "E": {
        let p: Pos = { row, col };
        for (let i = 0; i < count; i++) p = this.wordEnd(p, key === "E");
        return to(p, true);
      }
      case "b":
      case "B": {
        let p: Pos = { row, col };
        for (let i = 0; i < count; i++) p = this.wordBack(p, key === "B");
        return to(p);
      }
      case "f":
      case "t":
      case "F":
      case "T": {
        if (!arg) return null;
        const forward = key === "f" || key === "t";
        let at = col;
        for (let i = 0; i < count; i++) {
          at = forward ? line.indexOf(arg, at + 1) : at === 0 ? -1 : line.lastIndexOf(arg, at - 1);
          if (at < 0) return null;
        }
        if (key === "f") return to({ row, col: at }, true);
        if (key === "t") return to({ row, col: at - 1 }, true);
        return to({ row, col: key === "F" ? at : at + 1 });
      }
      case "n":
      case "N": {
        if (!this.search) {
          this.message = "E35: No previous regular expression";
          return null;
        }
        let p: Pos = { row, col };
        for (let i = 0; i < count; i++) {
          const found = this.searchFrom(p, key === "n" ? this.search.back : !this.search.back);
          if (!found) return null;
          p = found;
        }
        return to(p);
      }
      case "{":
      case "}": {
        const step = key === "}" ? 1 : -1;
        let r = row;
        for (let i = 0; i < count; i++) {
          while (r + step >= 0 && r + step <= last && this.lines[r]! === "") r += step; // off the blank lines we're on
          while (r + step >= 0 && r + step <= last && this.lines[r]! !== "") r += step;
          if (this.lines[r] !== "") return to({ row: r, col: step > 0 ? this.lines[r]!.length : 0 });
        }
        return to({ row: r, col: 0 });
      }
    }
    return null;
  }

  private wordForward(p: Pos, big: boolean): Pos {
    let { row, col } = p;
    const line = () => this.lines[row]!;
    const k = cls(line()[col], big);
    if (k !== 0) while (col < line().length && cls(line()[col], big) === k) col++;
    for (;;) {
      if (col >= line().length) {
        if (row === this.lines.length - 1) return { row, col: line().length };
        row++;
        col = 0;
        if (line() === "") return { row, col: 0 }; // an empty line is a word
        continue;
      }
      if (cls(line()[col], big) !== 0) return { row, col };
      col++;
    }
  }

  private wordEnd(p: Pos, big: boolean): Pos {
    let { row, col } = p;
    const line = () => this.lines[row]!;
    col++;
    for (;;) {
      if (col >= line().length) {
        if (row === this.lines.length - 1) return { row, col: Math.max(0, line().length - 1) };
        row++;
        col = 0;
        continue;
      }
      if (cls(line()[col], big) === 0) col++;
      else break;
    }
    const k = cls(line()[col], big);
    while (col + 1 < line().length && cls(line()[col + 1], big) === k) col++;
    return { row, col };
  }

  private wordBack(p: Pos, big: boolean): Pos {
    let { row, col } = p;
    const line = () => this.lines[row]!;
    col--;
    for (;;) {
      while (col < 0) {
        if (row === 0) return { row: 0, col: 0 };
        row--;
        col = line().length - 1;
        if (line() === "") return { row, col: 0 };
      }
      if (cls(line()[col], big) === 0) col--;
      else break;
    }
    const k = cls(line()[col], big);
    while (col > 0 && cls(line()[col - 1], big) === k) col--;
    return { row, col };
  }

  /** `iw`, `a"`, `i(` ... around `at`. */
  private object(arg: string, at: Pos): Range | null {
    const inner = arg[0] === "i";
    const kind = arg[1]!;
    const line = this.lines[at.row]!;
    const range = (a: Pos, b: Pos): Range => ({ a, b, linewise: false });

    if (kind === "w" || kind === "W") {
      if (line === "") return null;
      const big = kind === "W";
      const c = Math.min(at.col, line.length - 1);
      const k = cls(line[c], big);
      let s = c;
      let e = c;
      while (s > 0 && cls(line[s - 1], big) === k) s--;
      while (e + 1 < line.length && cls(line[e + 1], big) === k) e++;
      if (!inner) {
        // A word plus the blanks after it — or before it, when nothing follows.
        if (k !== 0) {
          let t = e;
          while (t + 1 < line.length && cls(line[t + 1], big) === 0) t++;
          if (t > e) e = t;
          else while (s > 0 && cls(line[s - 1], big) === 0) s--;
        } else if (e + 1 < line.length) {
          const next = cls(line[e + 1], big);
          while (e + 1 < line.length && cls(line[e + 1], big) === next) e++;
        }
      }
      return range({ row: at.row, col: s }, { row: at.row, col: e + 1 });
    }

    if (kind === '"' || kind === "'" || kind === "`") {
      const marks: number[] = [];
      for (let i = 0; i < line.length; i++) if (line[i] === kind && line[i - 1] !== "\\") marks.push(i);
      for (let p = 0; p + 1 < marks.length; p += 2) {
        const s = marks[p]!;
        const e = marks[p + 1]!;
        if (e < at.col) continue;
        if (inner) return range({ row: at.row, col: s + 1 }, { row: at.row, col: e });
        let end = e + 1;
        while (end < line.length && /\s/.test(line[end]!)) end++;
        return range({ row: at.row, col: s }, { row: at.row, col: end });
      }
      return null;
    }

    const pair = BRACKETS[kind];
    if (!pair) return null;
    let open: Pos | null = null;
    let depth = 0;
    scanBack: for (let r = at.row; r >= 0; r--) {
      const l = this.lines[r]!;
      for (let c = r === at.row ? at.col : l.length - 1; c >= 0; c--) {
        const ch = l[c];
        if (ch === pair[1] && !(r === at.row && c === at.col)) depth++;
        else if (ch === pair[0]) {
          if (depth === 0) {
            open = { row: r, col: c };
            break scanBack;
          }
          depth--;
        }
      }
    }
    if (!open) return null;
    let close: Pos | null = null;
    depth = 0;
    scanForward: for (let r = open.row; r < this.lines.length; r++) {
      const l = this.lines[r]!;
      for (let c = r === open.row ? open.col + 1 : 0; c < l.length; c++) {
        const ch = l[c];
        if (ch === pair[0]) depth++;
        else if (ch === pair[1]) {
          if (depth === 0) {
            close = { row: r, col: c };
            break scanForward;
          }
          depth--;
        }
      }
    }
    if (!close) return null;
    return inner
      ? range({ row: open.row, col: open.col + 1 }, close)
      : range(open, { row: close.row, col: close.col + 1 });
  }

  // ---- insert mode ----------------------------------------------------------

  private startInsert(): void {
    this.change();
    this.mode = "insert";
  }

  private insert(key: string): void {
    const line = this.lines[this.row]!;
    switch (key) {
      case "\x1b":
      case "\x03":
        this.mode = "normal";
        this.col = Math.max(0, this.col - 1);
        break;
      case "\r":
      case "\n":
        this.lines.splice(this.row, 1, line.slice(0, this.col), line.slice(this.col));
        this.row++;
        this.col = 0;
        break;
      case "\x7f":
      case "\b":
        if (this.col > 0) {
          this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
          this.col--;
        } else if (this.row > 0) {
          const prev = this.lines[this.row - 1]!;
          this.lines.splice(this.row - 1, 2, prev + line);
          this.row--;
          this.col = prev.length;
        }
        break;
      case "\x1b[3~":
        if (this.col < line.length) this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
        else if (this.row + 1 < this.lines.length) this.lines.splice(this.row, 2, line + this.lines[this.row + 1]);
        break;
      case "\x17": {
        // ^W: the word before the cursor
        const head = line.slice(0, this.col).replace(/(\w+|[^\w\s]+)?\s*$/, "");
        this.lines[this.row] = head + line.slice(this.col);
        this.col = head.length;
        break;
      }
      case "\x15":
        this.lines[this.row] = line.slice(this.col);
        this.col = 0;
        break;
      case "\t":
        this.lines[this.row] = line.slice(0, this.col) + SHIFT + line.slice(this.col);
        this.col += SHIFT.length;
        break;
      case "\x1b[A":
        if (this.row > 0) this.row--;
        this.col = Math.min(this.col, this.lines[this.row]!.length);
        return;
      case "\x1b[B":
        if (this.row + 1 < this.lines.length) this.row++;
        this.col = Math.min(this.col, this.lines[this.row]!.length);
        return;
      case "\x1b[C":
        if (this.col < line.length) this.col++;
        else if (this.row + 1 < this.lines.length) [this.row, this.col] = [this.row + 1, 0];
        return;
      case "\x1b[D":
        if (this.col > 0) this.col--;
        else if (this.row > 0) [this.row, this.col] = [this.row - 1, this.lines[this.row - 1]!.length];
        return;
      case "\x1b[H":
        this.col = 0;
        return;
      case "\x1b[F":
        this.col = line.length;
        return;
      default:
        if (key >= " " && !key.startsWith("\x1b")) {
          this.lines[this.row] = line.slice(0, this.col) + key + line.slice(this.col);
          this.col += key.length;
        }
    }
    this.wantCol = this.col;
  }

  // ---- search and the command line ----------------------------------------------

  private cmdline(key: string): Effect | void {
    if (key === "\x1b" || key === "\x03") {
      this.mode = "normal";
    } else if (key === "\x7f" || key === "\b") {
      if (this.cmd === "") this.mode = "normal";
      else this.cmd = this.cmd.slice(0, -1);
    } else if (key === "\x15") {
      this.cmd = "";
    } else if (key === "\r" || key === "\n") {
      const text = this.cmd;
      const searching = this.mode === "search";
      this.mode = "normal";
      this.cmd = "";
      return searching ? this.runSearch(text) : this.ex(text);
    } else if (key >= " " && !key.startsWith("\x1b")) {
      this.cmd += key;
    }
    return;
  }

  private runSearch(text: string): void {
    if (text !== "") this.search = { re: compile(text, "g"), back: this.searchBack, text };
    else if (this.search) this.search.back = this.searchBack;
    this.jumpToMatch(this.search?.back ?? false);
  }

  private starSearch(): void {
    const line = this.lines[this.row]!;
    const word = [...line.matchAll(/\w+/g)].find((m) => m.index + m[0].length > this.col);
    if (!word) return void (this.message = "E348: No string under cursor");
    this.search = { re: new RegExp(`\\b${escapeRegExp(word[0])}\\b`, "g"), back: false, text: word[0] };
    this.col = word.index;
    this.jumpToMatch(false);
  }

  private jumpToMatch(back: boolean): void {
    const found = this.searchFrom({ row: this.row, col: this.col }, back);
    if (!found) return;
    this.row = found.row;
    this.col = found.col;
    this.wantCol = found.col;
  }

  /** The next match after (or before) `from`, wrapping around the buffer. */
  private searchFrom(from: Pos, back: boolean): Pos | null {
    const search = this.search;
    if (!search) return null;
    const { re } = search;
    const n = this.lines.length;
    for (let k = 0; k <= n; k++) {
      const row = (((from.row + (back ? -k : k)) % n) + n) % n;
      const line = this.lines[row]!;
      const matches: number[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        matches.push(m.index);
        if (m[0] === "") re.lastIndex++;
      }
      const hit = back
        ? matches.filter((i) => k === n || k > 0 || i < from.col).pop()
        : matches.find((i) => k === n || k > 0 || i > from.col);
      if (hit !== undefined) {
        if (k > 0 && (back ? from.row - k < 0 : from.row + k >= n)) {
          this.message = back ? "search hit TOP, continuing at BOTTOM" : "search hit BOTTOM, continuing at TOP";
        }
        return { row, col: hit };
      }
    }
    this.message = `E486: Pattern not found: ${search.text}`;
    return null;
  }

  private ex(input: string): Effect | void {
    const text = input.trim();
    if (text === "") return;
    if (/^(\d+|\$)$/.test(text)) {
      this.row = Math.min(this.lines.length - 1, text === "$" ? Infinity : Math.max(0, Number(text) - 1));
      this.col = firstNonBlank(this.lines[this.row]!);
      this.wantCol = this.col;
      return;
    }
    const sub = /^(%|\d+(?:,\d+)?)?s([^\w\s\\"|])(.*)$/.exec(text);
    if (sub) return void this.substitute(sub[1], sub[2]!, sub[3]!);

    const m = /^(\w+)(!?)\s*(.*)$/.exec(text);
    if (!m) return void (this.message = `E492: Not an editor command: ${text}`);
    const [, word, bang, rest] = m as unknown as [string, string, string, string];
    const is = (full: string, short: number) => word.length >= short && full.startsWith(word);

    if (is("write", 1)) {
      const path = rest || this.name;
      return path ? { kind: "write", path, quit: false } : void (this.message = "E32: No file name");
    }
    if (is("quit", 1)) {
      if (this.modified && !bang) return void (this.message = "E37: No write since last change (add ! to override)");
      return { kind: "quit" };
    }
    if (word === "wq" || is("xit", 1) || is("exit", 3)) {
      const path = rest || this.name;
      return path ? { kind: "write", path, quit: true } : void (this.message = "E32: No file name");
    }
    if (is("set", 2)) {
      for (const option of rest.split(/\s+/)) {
        if (option === "nu" || option === "number") this.number = true;
        else if (option === "nonu" || option === "nonumber") this.number = false;
        else if (option) this.message = `E518: Unknown option: ${option}`;
      }
      return;
    }
    this.message = `E492: Not an editor command: ${text}`;
  }

  private substitute(range: string | undefined, delim: string, body: string): void {
    const parts: string[] = [];
    let cur = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "\\" && i + 1 < body.length) {
        cur += body[i + 1] === delim ? delim : ch + body[i + 1];
        i++;
      } else if (ch === delim && parts.length < 2) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    const [pattern = "", rep = "", flags = ""] = parts;

    let from = this.row;
    let to = this.row;
    if (range === "%") [from, to] = [0, this.lines.length - 1];
    else if (range) {
      const [a, b = a] = range.split(",").map(Number) as [number, number?];
      [from, to] = [Math.max(0, a - 1), Math.min(this.lines.length - 1, (b ?? a) - 1)];
    }

    const re = compile(pattern, (flags.includes("g") ? "g" : "") + (flags.includes("i") ? "i" : ""));
    const out = replacement(rep);
    this.change();
    let count = 0;
    let touched = 0;
    for (let r = from; r <= to; r++) {
      const line = this.lines[r]!;
      const next = line.replace(re, (...args: unknown[]) => {
        count++;
        // JavaScript expands `$&` and `$1` itself only in string replacements, so do it by hand.
        const groups = args.slice(0, args.findIndex((a) => typeof a === "number")) as string[];
        return out.replace(/\$([&$\d])/g, (_, g: string) => (g === "$" ? "$" : g === "&" ? groups[0]! : (groups[Number(g)] ?? "")));
      });
      if (next !== line) {
        // `\n` in the replacement splits the line.
        const pieces = next.split("\n");
        this.lines.splice(r, 1, ...pieces);
        r += pieces.length - 1;
        to += pieces.length - 1;
        touched++;
        this.row = r;
      }
    }
    if (count === 0) return void (this.message = `E486: Pattern not found: ${pattern}`);
    this.col = firstNonBlank(this.lines[this.row]!);
    this.wantCol = this.col;
    if (count > 2) this.message = `${count} substitutions on ${touched} line${touched === 1 ? "" : "s"}`;
  }

  // ---- drawing ------------------------------------------------------------------

  private clamp(): void {
    this.row = Math.min(Math.max(0, this.row), this.lines.length - 1);
    const len = this.lines[this.row]!.length;
    this.col = Math.min(Math.max(0, this.col), this.mode === "insert" ? len : Math.max(0, len - 1));
  }

  /** A screenful for a terminal of `rows` x `cols`: ESC[2J, then every row. */
  public render(rows: number, cols: number): string {
    this.rows = rows;
    const height = Math.max(1, rows - 1);
    if (this.row < this.top) this.top = this.row;
    else if (this.row >= this.top + height) this.top = this.row - height + 1;

    const gutter = this.number ? String(this.lines.length).length + 1 : 0;
    const width = Math.max(1, cols - gutter);
    const cursorCell = this.cell(this.lines[this.row]!, this.col);
    if (cursorCell < this.left) this.left = cursorCell;
    else if (cursorCell >= this.left + width) this.left = cursorCell - width + 1;

    const selection = this.selection();
    const out: string[] = [];
    for (let r = this.top; r < this.top + height; r++) {
      if (r >= this.lines.length) out.push("~");
      else out.push((gutter ? `${String(r + 1).padStart(gutter - 1)} ` : "") + this.drawLine(r, width, selection));
    }
    out.push(this.bottom(cols));
    return `\x1b[2J\x1b[H${out.join("\n")}`;
  }

  /** Screen column of character `i`, tabs being 8 wide. */
  private cell(line: string, i: number): number {
    let at = 0;
    for (let k = 0; k < i && k < line.length; k++) at += line[k] === "\t" ? 8 - (at % 8) : 1;
    return at;
  }

  private selection(): [Pos, Pos] | null {
    if (this.mode !== "visual" && this.mode !== "vline") return null;
    const here = { row: this.row, col: this.col };
    return before(here, this.anchor) ? [here, this.anchor] : [this.anchor, here];
  }

  private drawLine(r: number, width: number, selection: [Pos, Pos] | null): string {
    const line = this.lines[r]!;
    const showCursor = r === this.row && this.mode !== "command" && this.mode !== "search";
    const limit = this.left + width;
    const chars: string[] = [];
    const styles: number[] = []; // 0 plain, 1 cursor, 2 selected

    const selected = (i: number): boolean => {
      if (!selection) return false;
      const [a, b] = selection;
      if (r < a.row || r > b.row) return false;
      if (this.mode === "vline") return true;
      return !(r === a.row && i < a.col) && !(r === b.row && i > b.col);
    };
    for (let i = 0; i <= line.length && chars.length < limit; i++) {
      const style = showCursor && i === this.col ? 1 : selected(i) ? 2 : 0;
      if (i === line.length) {
        // The cell after the last character: the cursor in insert mode, or a selected line break.
        if (style) {
          chars.push(" ");
          styles.push(style);
        }
        break;
      }
      const w = line[i] === "\t" ? 8 - (chars.length % 8) : 1;
      for (let k = 0; k < w; k++) {
        chars.push(line[i] === "\t" ? " " : line[i]!);
        styles.push(style);
      }
    }

    let out = "";
    for (let i = this.left; i < Math.min(chars.length, limit); ) {
      let j = i;
      while (j < Math.min(chars.length, limit) && styles[j] === styles[i]) j++;
      const run = chars.slice(i, j).join("");
      out += styles[i] === 1 ? `\x1b[7m${run}\x1b[0m` : styles[i] === 2 ? `\x1b[100m${run}\x1b[0m` : run;
      i = j;
    }
    return out;
  }

  private bottom(cols: number): string {
    if (this.mode === "command" || this.mode === "search") {
      const prompt = this.mode === "command" ? ":" : this.searchBack ? "?" : "/";
      return `${(prompt + this.cmd).slice(-(cols - 2))}\x1b[7m \x1b[0m`;
    }
    const left =
      this.message ||
      (this.mode === "insert" ? "-- INSERT --" : this.mode === "visual" ? "-- VISUAL --" : this.mode === "vline" ? "-- VISUAL LINE --" : "");
    const height = Math.max(1, this.rows - 1);
    const shown = Math.min(this.lines.length, this.top + height);
    const where =
      this.top === 0 ? (shown >= this.lines.length ? "All" : "Top") : shown >= this.lines.length ? "Bot" : `${Math.floor((100 * this.top) / Math.max(1, this.lines.length - height))}%`;
    const ruler = `${this.modified ? "[+] " : ""}${this.row + 1},${this.col + 1}  ${where}`;
    const room = Math.max(0, cols - ruler.length - 1);
    return `${left.slice(0, room).padEnd(room)} ${ruler}`.slice(0, cols);
  }
}
