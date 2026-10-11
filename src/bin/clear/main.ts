// clear — like the real one, it doesn't touch the terminal directly. It writes
// the standard escape sequences to stdout and the terminal interprets them:
// ESC[H (cursor home), ESC[2J (erase screen), ESC[3J (erase scrollback).
import type { AppInterface } from "../../kernel/syscalls/api";

export async function main(os: AppInterface, _args: string[]): Promise<void> {
  await os.io.write(1, new TextEncoder().encode("\x1b[H\x1b[2J\x1b[3J"));
  await os.process.exit(0);
}
