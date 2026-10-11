// Shared by the text tools: read all of stdin, or every named file, as text.
import type { AppInterface } from "../../kernel/syscalls/api";

const encoder = new TextEncoder();

export function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? "EIO";
}

export async function print(os: AppInterface, fd: number, text: string): Promise<void> {
  if (text) await os.io.write(fd, encoder.encode(text));
}

async function readFd(os: AppInterface, fd: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await os.io.read(fd, 4096);
    if (chunk.length === 0) return text + decoder.decode();
    text += decoder.decode(chunk, { stream: true });
  }
}

/**
 * Concatenated input. A missing file is reported on stderr as `<name>: path: CODE`
 * and skipped; `ok` is false if any file failed.
 */
export async function readInput(
  os: AppInterface,
  name: string,
  paths: string[],
): Promise<{ text: string; ok: boolean }> {
  if (paths.length === 0) return { text: await readFd(os, 0), ok: true };

  let text = "";
  let ok = true;
  for (const path of paths) {
    try {
      text += await os.fs.readTextFile(path);
    } catch (error) {
      await print(os, 2, `${name}: ${path}: ${errorCode(error)}\n`);
      ok = false;
    }
  }
  return { text, ok };
}

/** "a\nb\n" -> ["a", "b"]; a missing final newline is fine. */
export function lines(text: string): string[] {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all;
}

export function joinLines(all: string[]): string {
  return all.length ? `${all.join("\n")}\n` : "";
}

/** `-n 5`, `-n5` or `-5` -> 5. Returns the count and the remaining args. */
export function countFlag(args: string[], fallback: number): { n: number; rest: string[] } {
  let n = fallback;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n") n = Number(args[++i]);
    else if (/^-n\d+$/.test(a)) n = Number(a.slice(2));
    else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
    else rest.push(a);
  }
  return { n: Number.isFinite(n) && n >= 0 ? n : fallback, rest };
}
