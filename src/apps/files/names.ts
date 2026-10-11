// Pure helpers for the Files app: collision-free names and human sizes.

/** "notes.txt" -> "notes copy.txt" -> "notes copy 2.txt", whatever's free. */
export function freeName(name: string, taken: ReadonlySet<string>, suffix = " copy"): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}${suffix}${n > 1 ? ` ${n}` : ""}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Self-check: node src/apps/files/names.ts
if ((import.meta as { main?: boolean }).main) {
  const assert = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`names self-check failed: ${what}`);
  };
  const taken = new Set(["a.txt", "a copy.txt", "a copy 2.txt", "dir"]);
  assert(freeName("b.txt", taken) === "b.txt", "free name kept");
  assert(freeName("a.txt", taken) === "a copy 3.txt", "next copy number");
  assert(freeName("dir", taken) === "dir copy", "no extension");
  assert(freeName(".env", new Set([".env"])) === ".env copy", "dotfile is all stem");
  assert(freeName("untitled folder", new Set(["untitled folder"]), "") === "untitled folder 2", "empty suffix");
  assert(formatSize(999) === "999 B", "bytes");
  assert(formatSize(1500) === "1.5 KB", "kb");
  assert(formatSize(250_000_000) === "250 MB", "mb");
  console.log("names: ok");
}
