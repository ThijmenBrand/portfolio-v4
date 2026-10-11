// Line diff for `diff`. Pure, so tools.check.ts can test it.
// ponytail: O(n·m) LCS table, fine for source files; Myers if big files matter.

export type Op = { kind: " " | "-" | "+"; line: string };

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ kind: " ", line: a[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ kind: "-", line: a[i++]! });
    else ops.push({ kind: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

/** Unified diff body (no ---/+++ header); "" when equal. */
export function unified(ops: Op[], context = 3): string {
  const changes = ops.flatMap((op, k) => (op.kind === " " ? [] : [k]));
  const out: string[] = [];
  let c = 0;
  while (c < changes.length) {
    // Changes closer than 2*context share one hunk.
    let last = c;
    while (last + 1 < changes.length && changes[last + 1]! - changes[last]! - 1 <= 2 * context) last++;
    const start = Math.max(0, changes[c]! - context);
    const end = Math.min(ops.length, changes[last]! + context + 1);
    c = last + 1;

    let aLine = 1;
    let bLine = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") aLine++;
      if (op.kind !== "-") bLine++;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aLen ? aLine : aLine - 1},${aLen} +${bLen ? bLine : bLine - 1},${bLen} @@`);
    for (const op of hunk) out.push(op.kind + op.line);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** Classic `diff` output: 2,3c2 / < old / --- / > new. */
export function normal(ops: Op[]): string {
  const out: string[] = [];
  let aLine = 0;
  let bLine = 0;
  let k = 0;
  const range = (from: number, len: number) => (len > 1 ? `${from},${from + len - 1}` : `${len ? from : from - 1}`);
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === " ") {
      aLine++, bLine++, k++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && ops[k]!.kind !== " ") {
      (ops[k]!.kind === "-" ? removed : added).push(ops[k]!.line);
      k++;
    }
    const kind = removed.length && added.length ? "c" : removed.length ? "d" : "a";
    out.push(`${range(aLine + 1, removed.length)}${kind}${range(bLine + 1, added.length)}`);
    for (const l of removed) out.push(`< ${l}`);
    if (kind === "c") out.push("---");
    for (const l of added) out.push(`> ${l}`);
    aLine += removed.length;
    bLine += added.length;
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
