// less — page through text, one key at a time. Switches the terminal to its
// alternate screen (ESC[?1049h), which also makes it forward single keys, and
// redraws the whole page (ESC[2J + rows) on every key. See `man less`.
import type { AppInterface } from "../../kernel/syscalls/api";
import { lines, print, readInput } from "../lib/input";

const isTty = (os: AppInterface, fd: number) =>
  os.io.tcgetattr(fd).then(
    () => true,
    () => false,
  );

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const stdinTty = await isTty(os, 0);
  if (args.length === 0 && stdinTty) {
    await print(os, 2, "usage: less file...   or   command | less\n");
    return os.process.exit(1);
  }
  const { text, ok } = await readInput(os, "less", args);
  if (!ok && !text) return os.process.exit(1); // readInput already said why
  if (!(await isTty(os, 1))) {
    await print(os, 1, text);
    return os.process.exit(ok ? 0 : 1);
  }
  const keys = stdinTty ? 0 : 2;
  if (!(await isTty(os, keys))) {
    await print(os, 1, text);
    return os.process.exit(ok ? 0 : 1);
  }

  const pager = new Pager(os, lines(text.replaceAll("\t", "        ")), args.join(" ") || "(stdin)");
  await pager.run(keys);
  await os.process.exit(ok ? 0 : 1);
}

class Pager {
  private top = 0;
  private rows = 24;
  private cols = 80;
  private message = "";
  private search?: RegExp;
  private typing?: string;

  private readonly os: AppInterface;
  private readonly text: string[];
  private readonly name: string;

  public constructor(os: AppInterface, text: string[], name: string) {
    this.os = os;
    this.text = text;
    this.name = name;
  }

  public async run(keys: number): Promise<void> {
    const { os } = this;
    let restored = false;
    const restore = async () => {
      if (restored) return;
      restored = true;
      await os.io.tcsetattr(keys, { icanon: true, echo: true }).catch(() => {});
      await print(os, 1, "\x1b[?1049l");
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      await os.process.onSignal(signal, () => void restore().then(() => os.process.exit(130)));
    }
    await os.process.onSignal("SIGWINCH", () => void this.measure().then(() => this.draw()));

    try {
      await os.io.tcsetattr(keys, { icanon: false, echo: false });
      await print(os, 1, "\x1b[?1049h");
      await this.measure();
      await this.draw();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await os.io.read(keys, 64);
        if (chunk.length === 0) return;
        for (const key of split(decoder.decode(chunk, { stream: true }))) {
          if ((await this.press(key)) === "quit") return;
        }
        await this.draw();
      }
    } finally {
      await restore();
    }
  }

  private async measure(): Promise<void> {
    const size = await this.os.io.getWinsize(1).catch(() => ({ rows: 24, cols: 80 }));
    this.rows = Math.max(2, size.rows);
    this.cols = Math.max(10, size.cols);
  }

  private get page(): number {
    return this.rows - 1;
  }

  private get bottom(): number {
    return Math.max(0, this.text.length - this.page);
  }

  private async press(key: string): Promise<"quit" | void> {
    this.message = "";
    if (this.typing !== undefined) return this.type(key);

    const scroll = (by: number) => (this.top = Math.min(this.bottom, Math.max(0, this.top + by)));
    switch (key) {
      case "q":
      case "Q":
        return "quit";
      case " ":
      case "f":
      case "\x1b[6~":
        return void scroll(this.page);
      case "b":
      case "\x1b[5~":
        return void scroll(-this.page);
      case "j":
      case "\r":
      case "\n":
      case "\x1b[B":
        return void scroll(1);
      case "k":
      case "\x1b[A":
        return void scroll(-1);
      case "d":
        return void scroll(this.page >> 1);
      case "u":
        return void scroll(-(this.page >> 1));
      case "g":
      case "\x1b[H":
        return void (this.top = 0);
      case "G":
      case "\x1b[F":
        return void (this.top = this.bottom);
      case "/":
        return void (this.typing = "");
      case "n":
        return this.find();
    }
  }

  private type(key: string): void {
    if (key === "\r" || key === "\n") {
      const pattern = this.typing!;
      this.typing = undefined;
      if (!pattern) return this.find();
      try {
        this.search = new RegExp(pattern, "i");
      } catch {
        this.search = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      return this.find();
    }
    if (key === "\x1b" || key === "\x03") this.typing = undefined;
    else if (key === "\x7f" || key === "\b") this.typing = this.typing!.slice(0, -1);
    else if (key.length === 1 && key >= " ") this.typing += key;
  }

  /** Next match below the top line, wrapping no further than the end. */
  private find(): void {
    if (!this.search) return void (this.message = "No previous search");
    for (let i = this.top + 1; i < this.text.length; i++) {
      if (this.search.test(this.text[i]!)) return void (this.top = i);
    }
    this.message = "Pattern not found";
  }

  private async draw(): Promise<void> {
    // ponytail: long lines are cut at the screen edge (less -S); wrap if missed.
    const shown = this.text.slice(this.top, this.top + this.page).map((l) => l.slice(0, this.cols));
    while (shown.length < this.page) shown.push("~");
    const percent = this.text.length ? Math.round((100 * Math.min(this.text.length, this.top + this.page)) / this.text.length) : 100;
    const status =
      this.typing !== undefined
        ? `/${this.typing}`
        : this.message ||
          `${this.name}  ${this.top >= this.bottom ? "(END)" : `${percent}%`}  (q quit, / search)`;
    // Inverse video is dropped by the terminal, harmless elsewhere.
    await print(this.os, 1, `\x1b[2J\x1b[H${shown.join("\n")}\n\x1b[7m${status.slice(0, this.cols)}\x1b[0m`);
  }
}

/** One read can hold several keys; escape sequences stay whole. */
function split(input: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < input.length; ) {
    const seq = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(input.slice(i));
    const key = seq ? seq[0] : input[i]!;
    keys.push(key);
    i += key.length;
  }
  return keys;
}
