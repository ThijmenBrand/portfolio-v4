// A small sed: `;`-separated commands, each `[addr[,addr]]cmd`.
// Addresses: N, $, /re/. Commands: s/re/rep/[gip], p, d, q, =.
// Pure, so tools.check.ts can test it. Regexes are JavaScript's (ERE-like).

type Addr = { line: number } | { last: true } | { re: RegExp };
type Cmd = {
  from?: Addr;
  to?: Addr;
  name: "s" | "p" | "d" | "q" | "=";
  re?: RegExp;
  rep?: string;
  print?: boolean;
  /** Range state: inside from..to. */
  active?: boolean;
};

function delimited(script: string, i: number, delim: string): [string, number] {
  let out = "";
  for (; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "\\" && script[i + 1] === delim) out += script[++i];
    else if (ch === "\\") out += ch + (script[++i] ?? "");
    else if (ch === delim) return [out, i + 1];
    else out += ch;
  }
  throw new Error(`unterminated \`${delim}'`);
}

function replacement(rep: string): string {
  let out = "";
  for (let i = 0; i < rep.length; i++) {
    const ch = rep[i]!;
    if (ch === "\\" && /\d/.test(rep[i + 1] ?? "")) out += `$${rep[++i]}`;
    else if (ch === "\\" && rep[i + 1] === "n") out += "\n", i++;
    else if (ch === "\\") out += (rep[++i] ?? "").replace("$", "$$");
    else if (ch === "&") out += "$&";
    else if (ch === "$") out += "$$";
    else out += ch;
  }
  return out;
}

function parseAddr(script: string, i: number): [Addr | undefined, number] {
  const num = /^\d+/.exec(script.slice(i));
  if (num) return [{ line: Number(num[0]) }, i + num[0].length];
  if (script[i] === "$") return [{ last: true }, i + 1];
  if (script[i] === "/") {
    const [re, next] = delimited(script, i + 1, "/");
    return [{ re: new RegExp(re) }, next];
  }
  return [undefined, i];
}

export function compile(script: string): Cmd[] {
  const cmds: Cmd[] = [];
  let i = 0;
  const skip = () => {
    while (i < script.length && /[\s;]/.test(script[i]!)) i++;
  };
  for (skip(); i < script.length; skip()) {
    const cmd: Partial<Cmd> = {};
    [cmd.from, i] = parseAddr(script, i);
    if (cmd.from && script[i] === ",") [cmd.to, i] = parseAddr(script, i + 1);
    while (script[i] === " ") i++;
    const name = script[i++];
    if (name === "s") {
      const delim = script[i++] ?? "";
      let re: string;
      let rep: string;
      [re, i] = delimited(script, i, delim);
      [rep, i] = delimited(script, i, delim);
      let flags = "";
      while (/[gip]/.test(script[i] ?? "")) flags += script[i++];
      cmd.re = new RegExp(re, (flags.includes("g") ? "g" : "") + (flags.includes("i") ? "i" : ""));
      cmd.rep = replacement(rep);
      cmd.print = flags.includes("p");
    } else if (!name || !"pdq=".includes(name)) {
      throw new Error(`unknown command: \`${name ?? ""}'`);
    }
    cmds.push({ ...cmd, name: name as Cmd["name"] });
  }
  return cmds;
}

function hit(addr: Addr, line: string, n: number, last: boolean): boolean {
  if ("line" in addr) return addr.line === n;
  if ("last" in addr) return last;
  return addr.re.test(line);
}

function selects(cmd: Cmd, line: string, n: number, last: boolean): boolean {
  if (!cmd.from) return true;
  if (!cmd.to) return hit(cmd.from, line, n, last);
  if (cmd.active) {
    // A line-number end that's already behind us closes the range at once.
    if (hit(cmd.to, line, n, last) || ("line" in cmd.to && cmd.to.line <= n)) cmd.active = false;
    return true;
  }
  if (!hit(cmd.from, line, n, last)) return false;
  cmd.active = !("line" in cmd.to && cmd.to.line <= n);
  return true;
}

export function run(cmds: Cmd[], input: string[], quiet = false): string[] {
  for (const cmd of cmds) cmd.active = false;
  const out: string[] = [];
  for (let n = 1; n <= input.length; n++) {
    let line = input[n - 1]!;
    const last = n === input.length;
    let deleted = false;
    let quit = false;
    for (const cmd of cmds) {
      if (!selects(cmd, line, n, last)) continue;
      if (cmd.name === "s") {
        const re = cmd.re!;
        re.lastIndex = 0;
        const matched = re.test(line);
        re.lastIndex = 0;
        line = line.replace(re, cmd.rep!);
        if (cmd.print && matched) out.push(line);
      } else if (cmd.name === "p") out.push(line);
      else if (cmd.name === "=") out.push(String(n));
      else if (cmd.name === "d") {
        deleted = true;
        break;
      } else if (cmd.name === "q") {
        quit = true;
        break;
      }
    }
    if (!deleted && !quiet) out.push(line);
    if (quit) break;
  }
  return out;
}
