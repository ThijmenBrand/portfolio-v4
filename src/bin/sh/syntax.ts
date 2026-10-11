/**
 * sh's grammar: source text -> tokens -> a small AST. Pure (no os, no DOM),
 * so `node src/bin/sh/syntax.check.ts` can test it. A POSIX-ish subset:
 *
 *   words      'single' "double $X $(cmd) $((1+2))" \escape ~ * ? [ab]
 *   commands   NAME=value cmd args <in >out >>out 2>err 2>&1
 *   pipelines  ! a | b | c
 *   lists      a && b || c ; d & e     (newlines work as ;)
 *   compound   if/elif/else/fi  while/until/do/done  for x in …; do … done
 *              { …; }  name() { …; }
 *
 * Not here: subshells ( … ), case, here-docs, backticks, ${x:-default}.
 * Input that just stops early (an open quote, `if` without `fi`, a trailing
 * `|`) throws Incomplete, so the caller can read another line and retry.
 */

/** One piece of a word. `q`: quoted, so never split or globbed. */
export type Seg =
  | { k: "lit"; v: string; q: boolean }
  | { k: "var"; name: string; q: boolean }
  | { k: "cmd"; src: string; q: boolean }
  | { k: "arith"; src: string; q: boolean };
export type Word = Seg[];

export interface Redirect {
  fd: number;
  /** `>&` duplicates: `2>&1` is { fd: 2, op: ">&", target: "1" }. */
  op: "<" | ">" | ">>" | ">&";
  target: Word;
}

export interface Simple {
  t: "simple";
  assigns: { name: string; value: Word }[];
  words: Word[];
  redirects: Redirect[];
}
export interface If {
  t: "if";
  clauses: { cond: List; body: List }[];
  otherwise?: List;
  redirects: Redirect[];
}
export interface Loop {
  t: "while";
  until: boolean;
  cond: List;
  body: List;
  redirects: Redirect[];
}
export interface For {
  t: "for";
  name: string;
  /** null: `for x; do` loops over "$@". */
  words: Word[] | null;
  body: List;
  redirects: Redirect[];
}
export interface Group {
  t: "group";
  body: List;
  redirects: Redirect[];
}
export interface FuncDef {
  t: "func";
  name: string;
  body: Command;
}
export type Command = Simple | If | Loop | For | Group | FuncDef;

export interface Pipeline {
  bang: boolean;
  cmds: Command[];
}
export interface AndOr {
  first: Pipeline;
  rest: { op: "&&" | "||"; pipeline: Pipeline }[];
}
export interface List {
  items: { andOr: AndOr; background: boolean }[];
}

/** The input ended mid-construct: more lines may complete it. */
export class Incomplete extends Error {}

// ------------------------------------------------------------------ lexer

type Tok =
  | { t: "word"; w: Word; raw: string }
  | { t: "op"; v: string; fd?: number };

const OPS = ["&&", "||", ">>", ">&", "<", ">", "|", ";", "&", "(", ")", "\n"];
const DELIM = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

export function lex(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2; // line continuation
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    const [w, end] = lexWord(src, i);
    const raw = src.slice(i, end);
    // `2>file`: digits glued to a redirect name the fd.
    const redirect = /^\d+$/.test(raw) && OPS.find((o) => "<>".includes(o[0]!) && src.startsWith(o, end));
    if (redirect) {
      tokens.push({ t: "op", v: redirect, fd: Number(raw) });
      i = end + redirect.length;
      continue;
    }
    tokens.push({ t: "word", w, raw });
    i = end;
  }
  return tokens;
}

function lexWord(src: string, start: number): [Word, number] {
  const word: Word = [];
  const lit = (v: string, q: boolean) => {
    const last = word[word.length - 1];
    if (last?.k === "lit" && last.q === q) last.v += v;
    else word.push({ k: "lit", v, q });
  };

  let i = start;
  while (i < src.length && !DELIM.has(src[i]!)) {
    const c = src[i]!;
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Incomplete("unterminated '");
      lit(src.slice(i + 1, end), true); // even '': a quoted segment makes a word
      i = end + 1;
    } else if (c === '"') {
      i = lexDouble(src, i + 1, word, lit);
    } else if (c === "\\") {
      if (i + 1 >= src.length) throw new Incomplete("trailing \\");
      if (src[i + 1] !== "\n") lit(src[i + 1]!, true);
      i += 2;
    } else if (c === "$") {
      i = lexDollar(src, i, false, word, lit);
    } else if (
      c === "~" &&
      i === start &&
      (i + 1 >= src.length || src[i + 1] === "/" || DELIM.has(src[i + 1]!))
    ) {
      word.push({ k: "var", name: "HOME", q: true });
      i += 1;
    } else {
      lit(c, false);
      i += 1;
    }
  }
  return [word, i];
}

/** Inside "…": only $ and \ are special. Returns the index after the closing quote. */
function lexDouble(
  src: string,
  i: number,
  word: Word,
  lit: (v: string, q: boolean) => void,
): number {
  const before = word.length;
  for (;;) {
    if (i >= src.length) throw new Incomplete('unterminated "');
    const c = src[i]!;
    if (c === '"') break;
    if (c === "\\" && '$`"\\\n'.includes(src[i + 1] ?? "")) {
      if (src[i + 1] !== "\n") lit(src[i + 1]!, true);
      i += 2;
    } else if (c === "$") {
      i = lexDollar(src, i, true, word, lit);
    } else {
      lit(c, true);
      i += 1;
    }
  }
  if (word.length === before) word.push({ k: "lit", v: "", q: true }); // "" is a word
  return i + 1;
}

function lexDollar(
  src: string,
  i: number,
  q: boolean,
  word: Word,
  lit: (v: string, q: boolean) => void,
): number {
  const next = src[i + 1] ?? "";
  if (src.startsWith("$((", i)) {
    const end = matchParen(src, i + 3); // the inner "(", at i + 2
    if (src[end + 1] !== ")") throw new SyntaxError("$(( needs ))");
    word.push({ k: "arith", src: src.slice(i + 3, end), q });
    return end + 2;
  }
  if (next === "(") {
    const end = matchParen(src, i + 2);
    word.push({ k: "cmd", src: src.slice(i + 2, end), q });
    return end + 1;
  }
  if (next === "{") {
    const end = src.indexOf("}", i + 2);
    if (end < 0) throw new Incomplete("unterminated ${");
    const name = src.slice(i + 2, end);
    if (!/^(?:[A-Za-z_]\w*|\d+|[?#@*$])$/.test(name)) {
      throw new SyntaxError(`\${${name}}: bad substitution`);
    }
    word.push({ k: "var", name, q });
    return end + 1;
  }
  if (/[?#@*$0-9]/.test(next)) {
    word.push({ k: "var", name: next, q });
    return i + 2;
  }
  const name = /^[A-Za-z_]\w*/.exec(src.slice(i + 1))?.[0];
  if (name) {
    word.push({ k: "var", name, q });
    return i + 1 + name.length;
  }
  lit("$", q);
  return i + 1;
}

/** Index of the `)` closing the `(` before `from`; quotes and nesting respected. */
function matchParen(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === "\\") i += 1;
    else if (c === "'") {
      i = src.indexOf("'", i + 1);
      if (i < 0) break;
    } else if (c === '"') {
      for (i += 1; i < src.length && src[i] !== '"'; i += 1) if (src[i] === "\\") i += 1;
    } else if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Incomplete("unterminated $(");
}

// ----------------------------------------------------------------- parser

const RESERVED = new Set(["if", "then", "elif", "else", "fi", "while", "until", "do", "done", "for", "in", "{", "}", "!"]);

export function parse(src: string): List {
  const p = new Parser(lex(src));
  const list = p.list(() => false);
  if (!p.done()) throw new SyntaxError(`syntax error near \`${p.describe()}\``);
  return list;
}

class Parser {
  private i = 0;
  private readonly tokens: Tok[];

  public constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }

  public done(): boolean {
    return this.i >= this.tokens.length;
  }

  public describe(): string {
    const tok = this.tokens[this.i];
    if (!tok) return "end of input";
    return tok.t === "word" ? tok.raw : tok.v === "\n" ? "newline" : tok.v;
  }

  private peek(): Tok | undefined {
    return this.tokens[this.i];
  }

  private isOp(...ops: string[]): boolean {
    const tok = this.peek();
    return tok?.t === "op" && ops.includes(tok.v);
  }

  private isKw(...words: string[]): boolean {
    const tok = this.peek();
    return tok?.t === "word" && words.includes(tok.raw);
  }

  private fail(): never {
    if (this.done()) throw new Incomplete("unexpected end of input");
    throw new SyntaxError(`syntax error near \`${this.describe()}\``);
  }

  private expectKw(word: string): void {
    if (!this.isKw(word)) this.fail();
    this.i += 1;
  }

  private newlines(): void {
    while (this.isOp("\n")) this.i += 1;
  }

  /** Commands until `stop` (checked only where a command could start) or the end. */
  public list(stop: () => boolean): List {
    const items: List["items"] = [];
    for (;;) {
      while (this.isOp("\n", ";")) this.i += 1;
      if (this.done() || stop() || this.isOp(")")) return { items };
      const andOr = this.andOr();
      const background = this.isOp("&");
      if (this.isOp("&", ";", "\n")) this.i += 1;
      else if (!this.done() && !stop()) this.fail();
      items.push({ andOr, background });
    }
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr["rest"] = [];
    while (this.isOp("&&", "||")) {
      const op = (this.peek() as { v: "&&" | "||" }).v;
      this.i += 1;
      this.newlines();
      rest.push({ op, pipeline: this.pipeline() });
    }
    return { first, rest };
  }

  private pipeline(): Pipeline {
    const bang = this.isKw("!");
    if (bang) this.i += 1;
    const cmds = [this.command()];
    while (this.isOp("|")) {
      this.i += 1;
      this.newlines();
      cmds.push(this.command());
    }
    return { bang, cmds };
  }

  private command(): Command {
    const tok = this.peek();
    if (!tok) this.fail();
    if (tok.t === "op" && tok.v === "(") {
      throw new SyntaxError("( … ) subshells aren't supported; use { …; }");
    }
    if (this.isKw("if")) return this.withRedirects(this.ifClause());
    if (this.isKw("while", "until")) return this.withRedirects(this.whileClause());
    if (this.isKw("for")) return this.withRedirects(this.forClause());
    if (this.isKw("{")) return this.withRedirects(this.group());
    const next = this.tokens[this.i + 1];
    const after = this.tokens[this.i + 2];
    if (tok.t === "word" && next?.t === "op" && next.v === "(") {
      if (after?.t !== "op" || after.v !== ")") this.fail();
      if (!/^[A-Za-z_][\w-]*$/.test(tok.raw) || RESERVED.has(tok.raw)) {
        throw new SyntaxError(`\`${tok.raw}\`: not a valid function name`);
      }
      this.i += 3;
      this.newlines();
      const body = this.command();
      if (body.t === "simple" || body.t === "func") {
        throw new SyntaxError(`${tok.raw}(): the body must be { …; } or another compound command`);
      }
      return { t: "func", name: tok.raw, body };
    }
    if (tok.t === "word" && RESERVED.has(tok.raw) && tok.raw !== "!") this.fail();
    return this.simple();
  }

  private simple(): Simple {
    const cmd: Simple = { t: "simple", assigns: [], words: [], redirects: [] };
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "word") {
        const assign = cmd.words.length === 0 ? assignment(tok.w) : null;
        if (assign) cmd.assigns.push(assign);
        else cmd.words.push(tok.w);
        this.i += 1;
      } else if (!this.redirect(cmd.redirects)) {
        break;
      }
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirects.length === 0) this.fail();
    return cmd;
  }

  /** One redirect into `into`, if the next tokens are one. */
  private redirect(into: Redirect[]): boolean {
    const tok = this.peek();
    if (tok?.t !== "op" || !["<", ">", ">>", ">&"].includes(tok.v)) return false;
    this.i += 1;
    const target = this.peek();
    if (target?.t !== "word") this.fail();
    this.i += 1;
    into.push({
      fd: tok.fd ?? (tok.v === "<" ? 0 : 1),
      op: tok.v as Redirect["op"],
      target: target.w,
    });
    return true;
  }

  private withRedirects<T extends { redirects: Redirect[] }>(cmd: T): T {
    while (this.redirect(cmd.redirects));
    return cmd;
  }

  private ifClause(): If {
    this.expectKw("if");
    const clauses: If["clauses"] = [];
    let otherwise: List | undefined;
    for (;;) {
      const cond = this.list(() => this.isKw("then"));
      this.expectKw("then");
      const body = this.list(() => this.isKw("elif", "else", "fi"));
      clauses.push({ cond, body });
      if (this.isKw("elif")) {
        this.i += 1;
        continue;
      }
      if (this.isKw("else")) {
        this.i += 1;
        otherwise = this.list(() => this.isKw("fi"));
      }
      this.expectKw("fi");
      return { t: "if", clauses, otherwise, redirects: [] };
    }
  }

  private whileClause(): Loop {
    const until = this.isKw("until");
    this.i += 1;
    const cond = this.list(() => this.isKw("do"));
    this.expectKw("do");
    const body = this.list(() => this.isKw("done"));
    this.expectKw("done");
    return { t: "while", until, cond, body, redirects: [] };
  }

  private forClause(): For {
    this.expectKw("for");
    const tok = this.peek();
    if (tok?.t !== "word") this.fail();
    if (!/^[A-Za-z_]\w*$/.test(tok.raw)) throw new SyntaxError(`for: \`${tok.raw}\`: not a valid name`);
    this.i += 1;
    this.newlines();
    let words: Word[] | null = null;
    if (this.isKw("in")) {
      this.i += 1;
      words = [];
      for (let t = this.peek(); t?.t === "word"; t = this.peek()) {
        words.push(t.w);
        this.i += 1;
      }
    }
    if (this.isOp(";", "\n")) this.i += 1;
    this.newlines();
    this.expectKw("do");
    const body = this.list(() => this.isKw("done"));
    this.expectKw("done");
    return { t: "for", name: tok.raw, words, body, redirects: [] };
  }

  private group(): Group {
    this.expectKw("{");
    const body = this.list(() => this.isKw("}"));
    this.expectKw("}");
    return { t: "group", body, redirects: [] };
  }
}

/** `NAME=value` (the NAME= part unquoted) -> the assignment, else null. */
export function assignment(word: Word): { name: string; value: Word } | null {
  const first = word[0];
  if (first?.k !== "lit" || first.q) return null;
  const match = /^([A-Za-z_]\w*)=/.exec(first.v);
  if (!match) return null;
  const rest = first.v.slice(match[0].length);
  return {
    name: match[1]!,
    value: [...(rest ? [{ ...first, v: rest }] : []), ...word.slice(1)],
  };
}

// ------------------------------------------------------------- arithmetic

/**
 * `$(( … ))`: integers, + - * / % ** ( ), comparisons, && || !, and bare
 * variable names (looked up, empty = 0). No assignment operators.
 */
export function arith(expr: string, lookup: (name: string) => string): number {
  const tokens = expr.match(/\d+|[A-Za-z_]\w*|\*\*|[<>=!]=|&&|\|\||[-+*/%()<>!]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  // Lowest precedence first; ** (right-associative) is in power().
  const BINARY = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
  const apply = (op: string, a: number, b: number): number => {
    switch (op) {
      case "||": return Number(a !== 0 || b !== 0);
      case "&&": return Number(a !== 0 && b !== 0);
      case "==": return Number(a === b);
      case "!=": return Number(a !== b);
      case "<": return Number(a < b);
      case ">": return Number(a > b);
      case "<=": return Number(a <= b);
      case ">=": return Number(a >= b);
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "**": return a ** b;
      case "/":
      case "%":
        if (b === 0) throw new Error("division by zero");
        return op === "/" ? Math.trunc(a / b) : a % b;
    }
    throw new SyntaxError(`bad operator ${op}`);
  };

  const binary = (level: number): number => {
    if (level === BINARY.length) return power();
    let left = binary(level + 1);
    while (BINARY[level]!.includes(peek() ?? "")) {
      const op = take()!;
      left = apply(op, left, binary(level + 1));
    }
    return left;
  };
  const power = (): number => {
    const base = unary();
    return peek() === "**" ? (take(), apply("**", base, power())) : base;
  };
  const unary = (): number => {
    const tok = take();
    if (tok === "-") return -unary();
    if (tok === "+") return unary();
    if (tok === "!") return Number(unary() === 0);
    if (tok === "(") {
      const value = binary(0);
      if (take() !== ")") throw new SyntaxError("missing )");
      return value;
    }
    if (tok !== undefined && /^\d+$/.test(tok)) return Number(tok);
    if (tok !== undefined && /^[A-Za-z_]\w*$/.test(tok)) {
      const value = lookup(tok).trim();
      if (value === "") return 0;
      if (!/^-?\d+$/.test(value)) throw new SyntaxError(`${tok}: not a number: ${value}`);
      return Number(value);
    }
    throw new SyntaxError(`arithmetic: syntax error near \`${tok ?? "end"}\``);
  };

  const value = binary(0);
  if (i < tokens.length) throw new SyntaxError(`arithmetic: syntax error near \`${peek()}\``);
  return value;
}

// ------------------------------------------------------------------ globs

/** Does a pattern (with \-escaped literals) use * ? or [ ]? */
export const hasGlob = (pattern: string): boolean => /(?:^|[^\\])(?:\\\\)*[*?[]/.test(pattern);

/** Escape a literal for use in a glob pattern. */
export const escapeGlob = (text: string): string => text.replace(/[\\*?[\]]/g, "\\$&");

/** Undo escapeGlob: the literal a pattern stands for when nothing matches. */
export const unescapeGlob = (pattern: string): string => pattern.replace(/\\(.)/g, "$1");

/** One path segment's pattern as a RegExp: `*` and `?` never cross a `/`. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      out += escapeRe(pattern[++i]!);
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) {
        out += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      out += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(`^${out}$`);
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
