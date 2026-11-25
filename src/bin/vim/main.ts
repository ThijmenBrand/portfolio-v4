// vim — a modal text editor. Like `less` it takes over the terminal's alternate
// screen (ESC[?1049h), reads single keys, and redraws the whole screen after each
// batch. The editing itself lives in lib/vim.ts. See `man vim`.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";
import { Vim } from "../lib/vim";

const isTty = (os: AppInterface, fd: number) =>
  os.io.tcgetattr(fd).then(
    () => true,
    () => false,
  );

export async function main(os: AppInterface, args: string[]): Promise<void> {
  if (args.length > 1) {
    await print(os, 2, "usage: vim [file]\n");
    return os.process.exit(2);
  }
  if (!(await isTty(os, 0)) || !(await isTty(os, 1))) {
    await print(os, 2, "vim: needs a terminal\n");
    return os.process.exit(1);
  }

  const name = args[0];
  let text = "";
  let note = "";
  if (name) {
    try {
      text = await os.fs.readTextFile(name);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        await print(os, 2, `vim: ${name}: ${errorCode(error)}\n`);
        return os.process.exit(1);
      }
      note = `"${name}" [New]`;
    }
  }

  const vim = new Vim(text, name);
  if (!note && name) note = `"${name}" ${vim.lines.length}L, ${new TextEncoder().encode(text).length}B`;
  vim.message = note;
  await run(os, vim);
  await os.process.exit(0);
}

async function run(os: AppInterface, vim: Vim): Promise<void> {
  let size = { rows: 24, cols: 80 };
  const draw = async () => print(os, 1, vim.render(size.rows, size.cols));
  const measure = async () => {
    size = await os.io.getWinsize(1).then(
      ({ rows, cols }) => ({ rows: Math.max(2, rows), cols: Math.max(10, cols) }),
      () => size,
    );
  };

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await os.io.tcsetattr(0, { icanon: true, echo: true, isig: true }).catch(() => {});
    await print(os, 1, "\x1b[?1049l");
  };
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    await os.process.onSignal(signal, () => void restore().then(() => os.process.exit(143)));
  }
  await os.process.onSignal("SIGWINCH", () => void measure().then(draw));

  try {
    // isig off: ^C reaches us as a key (it leaves insert mode) instead of killing the editor.
    await os.io.tcsetattr(0, { icanon: false, echo: false, isig: false });
    await print(os, 1, "\x1b[?1049h");
    await measure();
    await draw();

    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await os.io.read(0, 4096);
      if (chunk.length === 0) return; // the terminal went away
      for (const key of split(decoder.decode(chunk, { stream: true }))) {
        vim.render(size.rows, size.cols); // keeps scrolling in step with the keys of one paste
        const effect = vim.feed(key);
        if (!effect) continue;
        if (effect.kind === "quit") return;
        try {
          await os.fs.writeTextFile(effect.path, vim.content());
          vim.wrote(effect.path);
          if (effect.quit) return;
        } catch (error) {
          vim.message = `E212: Can't open file for writing (${errorCode(error)})`;
        }
      }
      await draw();
    }
  } finally {
    await restore();
  }
}

/** One read can hold several keys (a paste); escape sequences and code points stay whole. */
function split(input: string): string[] {
  const keys: string[] = [];
  const sequence = /\x1b\[[0-9;]*[A-Za-z~]/y;
  for (let i = 0; i < input.length; ) {
    sequence.lastIndex = i;
    const key = sequence.exec(input)?.[0] ?? String.fromCodePoint(input.codePointAt(i)!);
    keys.push(key);
    i += key.length;
  }
  return keys;
}
