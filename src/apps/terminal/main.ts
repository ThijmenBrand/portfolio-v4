import type { AppInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import terminalHTML from "./terminal.html?raw";
import "./terminal.css";
import "../../ui/theme.css";
import type { Pid, Termination } from "../../kernel/types";
import type { WindowHandle } from "../../kernel/windows/types";
import { AnsiParser } from "./ansi";
import { complete } from "./complete";

const SHELL_PATH = "/ProgramFiles/sh";
const MAX_CHARS = 200_000;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

class Terminal {
  private readonly os: AppInterface;
  private readonly out: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly hints: HTMLElement;

  private readonly encoder = new TextEncoder();
  /** Streaming: a 4KB read can split a multi-byte sequence across chunks. */
  private readonly decoder = new TextDecoder();
  private readonly ansi = new AnsiParser();

  private readonly history: string[] = [];
  private historyIndex = 0;

  private shell: Pid = 0 as Pid;

  private master = -1;
  private disposed = false;

  public constructor(os: AppInterface, handle: WindowHandle) {
    this.os = os;

    void handle.onCloseRequest(() => void os.process.exit(0));

    const root = htmlStringToTemplate(terminalHTML);
    // An iframe app owns its whole document.
    document.body.appendChild(root);

    this.out = selectElementFromTemplate(root, '[data-field="out"]');
    this.input = selectElementFromTemplate(root, '[data-field="input"]');
    this.hints = selectElementFromTemplate(root, '[data-field="hints"]');

    this.bindInput();
    root.addEventListener("mouseup", () => {
      if (window.getSelection()?.isCollapsed !== false) this.input.focus();
    });
  }

  /** Everything that can fail lives here, so main() can report it. */
  public async start(): Promise<void> {
    const { master, slave } = await this.os.io.openpty();
    this.master = master;

    this.shell = await this.os.process.spawn(SHELL_PATH, [], {
      fds: { 0: slave, 1: slave, 2: slave },
    });

    // CRITICAL. Three entries in the child's table share one description, so
    // its refs is 3 — plus ours, 4. Until we drop ours, the slave end never
    // reaches zero, and the read loop below would never see EOF.
    await this.os.io.close(slave);

    void this.pump();
    void this.reap(this.shell);
    this.input.focus();
  }

  public dispose(): void {
    this.disposed = true;
  }

  /** Master -> screen. Ends when the shell exits and its slave end closes. */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.os.io.read(this.master, 4096);
        if (chunk.length === 0) break;
        this.render(this.decoder.decode(chunk, { stream: true }));
      }
    } catch (error) {
      // EINTR is our own termination aborting the parked read — not a fault.
      if (errorCode(error) === "EINTR" || this.disposed) return;
      this.append(`\n[terminal: ${errorCode(error) ?? "error"}]\n`);
    }
  }

  private async reap(shell: Pid): Promise<void> {
    let termination: Termination;
    try {
      termination = await this.os.process.wait(shell);
    } catch (error) {
      // EINTR: WE are exiting (e.g. the window's ✕) and the kernel cancelled
      // our pending wait — expected, not a fault. Same rule as pump().
      if (errorCode(error) === "EINTR" || this.disposed) return;
      this.append(`\n[terminal: wait failed: ${errorCode(error) ?? "error"}]\n`);
      return;
    }
    if (this.disposed) return;

    this.append(`\n[${SHELL_PATH} exited with ${termination.code}]\n`);
    this.input.disabled = true;
    this.input.placeholder = "shell exited";
  }

  private bindInput(): void {
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault(); // keep focus in the input
        void this.completeInput();
        return;
      }
      // Any other key makes the shown candidates stale.
      this.showHints([]);

      if (event.key === "Enter") {
        const line = this.input.value;
        this.input.value = "";
        this.history.push(line);
        this.historyIndex = this.history.length;

        // Raw mode: no kernel line discipline, so the terminal echoes.
        this.append(`${line}\n`);
        void this.send(`${line}\n`);
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        this.recall(event.key === "ArrowUp" ? -1 : 1);
      }

      // Ctrl-L: clear locally, like readline does — keep the current prompt line.
      if (event.key === "l" && event.ctrlKey) {
        event.preventDefault();
        this.clearScreen(true);
        return;
      }

      if (event.key === "c" && event.ctrlKey) {
        event.preventDefault();
        this.append("^C\n");
        this.input.value = "";
        // ESRCH — the shell is already gone; reap() has said so.
        void this.os.process.kill(this.shell, "SIGINT").catch(() => {});
        return;
      }
    });
  }

  private async completeInput(): Promise<void> {
    const line = this.input.value;
    const cursor = this.input.selectionStart ?? line.length;

    const result = await complete(this.os, await this.shellCwd(), line, cursor);

    // The user kept typing while we were asking the kernel: drop the result.
    if (this.input.value !== line) return;

    this.input.value = result.value;
    this.input.setSelectionRange(result.cursor, result.cursor);
    this.showHints(result.candidates);
  }

  /** The shell's cwd, not ours — `cd` changes the shell, never the terminal. */
  private async shellCwd(): Promise<string> {
    try {
      const cwd = (await this.os.fs.readTextFile(`/proc/${this.shell}/cwd`)).trim();
      return cwd || "/";
    } catch {
      return "/"; // shell gone or not started yet
    }
  }

  private showHints(candidates: string[]): void {
    this.hints.hidden = candidates.length === 0;
    this.hints.textContent = candidates.join("  ");
  }

  private recall(direction: number): void {
    if (this.history.length === 0) return;
    this.historyIndex = Math.min(
      this.history.length,
      Math.max(0, this.historyIndex + direction),
    );
    this.input.value = this.history[this.historyIndex] ?? "";
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );
  }

  private async send(text: string): Promise<void> {
    try {
      await this.os.io.write(this.master, this.encoder.encode(text));
    } catch (error) {
      // EPIPE means the shell is gone; reap() already said so.
      if (errorCode(error) !== "EPIPE") throw error;
    }
  }

  /** Program output: text plus the few escape sequences we understand. */
  private render(chunk: string): void {
    for (const segment of this.ansi.feed(chunk)) {
      if (segment.kind === "clear") this.clearScreen(false);
      else this.append(segment.text);
    }
  }

  /**
   * Wipe the output pane. Ctrl-L keeps the last line (the shell's prompt);
   * `clear` doesn't need to, because sh prints a fresh prompt after it exits.
   */
  private clearScreen(keepPrompt: boolean): void {
    const all = this.out.textContent ?? "";
    this.out.textContent = keepPrompt ? all.slice(all.lastIndexOf("\n") + 1) : "";
    this.out.scrollTop = 0;
  }

  private append(text: string): void {
    const atBottom =
      this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 4;

    this.out.appendChild(document.createTextNode(text));

    if (this.out.textContent && this.out.textContent.length > MAX_CHARS) {
      this.out.textContent = this.out.textContent.slice(-MAX_CHARS);
    }
    if (atBottom) this.out.scrollTop = this.out.scrollHeight;
  }
}

export async function main(os: AppInterface): Promise<void> {
  const handle = await os.windows.create({
    title: "Terminal",
    width: 680,
    height: 440,
    minWidth: 360,
    minHeight: 220,
  });

  const terminal = new Terminal(os, handle);
  await os.process.onSignal("SIGTERM", () => terminal.dispose());
  await terminal.start();
}
