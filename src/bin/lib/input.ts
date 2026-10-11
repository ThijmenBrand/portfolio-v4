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

/** One line from `fd`, without the newline; null at EOF. */
export async function readLine(os: AppInterface, fd: number): Promise<string | null> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await os.io.read(fd, 1024);
    if (chunk.length === 0) return text || null;
    text += decoder.decode(chunk, { stream: true });
    const newline = text.indexOf("\n");
    // ponytail: anything typed after the newline is dropped; fine for a prompt.
    if (newline >= 0) return text.slice(0, newline);
  }
}

/**
 * Prompts on stdout and reads stdin without echo: the pty stops echoing,
 * and ESC[8m tells the terminal to mask its input box. Not a terminal
 * (a piped password): just read the line.
 */
export async function askPassword(os: AppInterface, prompt: string): Promise<string> {
  const echoed = await os.io
    .tcgetattr(0)
    .then((termios) => termios.echo)
    .catch(() => false);
  if (echoed) await os.io.tcsetattr(0, { echo: false });
  await print(os, 1, `${prompt}\x1b[8m`);
  try {
    return (await readLine(os, 0)) ?? "";
  } finally {
    if (echoed) await os.io.tcsetattr(0, { echo: true }).catch(() => {});
    // The newline the user typed wasn't echoed either.
    await print(os, 1, "\x1b[28m\n");
  }
}
