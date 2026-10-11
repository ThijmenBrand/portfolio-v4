import type { AppInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import terminalHTML from "./terminal.html?raw";
import "./terminal.css";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";
import type { Pid, Termination } from "../../kernel/types";
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

export class Terminal {
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
  // ponytail: sniffs sh's `user:<cwd> $ ` (or `# `) prompt; a prompt change needs this too.
  private markPrompted!: () => void;
  private readonly prompted = new Promise<void>(
    (done) => (this.markPrompted = done),
  );
  private disposed = false;
  /** A program asked to hide input (ESC[8m): a password prompt. */
  private concealed = false;
  private readonly onExit?: () => void;

  /** `onExit` replaces the "shell exited" notice, e.g. to close an embedding panel. */
  public constructor(os: AppInterface, parent: HTMLElement, onExit?: () => void) {
    this.os = os;
    this.onExit = onExit;

    const root = htmlStringToTemplate(terminalHTML);
    parent.appendChild(root);

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

  public focus(): void {
    this.input.focus();
  }

  /** Runs `line` as if typed, once the shell has shown its first prompt. */
  public async run(line: string): Promise<void> {
    await this.prompted;
    // Raw mode: no kernel line discipline, so the terminal echoes — except
    // a password, which also stays out of the history.
    if (this.concealed) {
      this.append("\n");
    } else {
      this.history.push(line);
      this.historyIndex = this.history.length;
      this.append(`${line}\n`);
    }
    await this.send(`${line}\n`);
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
    if (this.onExit) return this.onExit();

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
      this.scrollToEnd();

      if (event.key === "Enter") {
        const line = this.input.value;
        this.input.value = "";
        void this.run(line);
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

    const [cwd, path] = await Promise.all([this.shellCwd(), this.shellPath()]);
    const result = await complete(this.os, cwd, path, line, cursor);

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

  /** The shell's PATH, so `export PATH=...` changes what completes. */
  private async shellPath(): Promise<string[]> {
    try {
      const environ = await this.os.fs.readTextFile(
        `/proc/${this.shell}/environ`,
      );
      const line = environ.split("\n").find((l) => l.startsWith("PATH="));
      return (line?.slice(5) ?? "").split(":").filter(Boolean);
    } catch {
      return []; // shell gone or not started yet
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
      else if (segment.kind === "conceal") this.conceal(segment.on);
      else this.append(segment.text);
    }
    if (chunk.endsWith("$ ") || chunk.endsWith("# ")) this.markPrompted();
  }

  private conceal(on: boolean): void {
    this.concealed = on;
    this.input.type = on ? "password" : "text";
  }

  /**
   * Wipe the output pane. Ctrl-L keeps the last line (the shell's prompt);
   * `clear` doesn't need to, because sh prints a fresh prompt after it exits.
   */
  private clearScreen(keepPrompt: boolean): void {
    const all = this.text();
    this.setText(keepPrompt ? all.slice(all.lastIndexOf("\n") + 1) : "");
    this.out.scrollTop = 0;
  }

  /** Output only: the input lives inside `out` as its last child. */
  private text(): string {
    let all = "";
    for (const node of this.out.childNodes) {
      if (node !== this.input) all += node.textContent ?? "";
    }
    return all;
  }

  private setText(text: string): void {
    this.out.replaceChildren(document.createTextNode(text), this.input);
    this.input.focus();
  }

  private scrollToEnd(): void {
    this.out.scrollTop = this.out.scrollHeight;
  }

  private append(text: string): void {
    const atBottom =
      this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 4;

    // Before the input, so typing always continues right after the prompt.
    this.out.insertBefore(document.createTextNode(text), this.input);

    if ((this.out.textContent?.length ?? 0) > MAX_CHARS) {
      this.setText(this.text().slice(-MAX_CHARS));
    }
    if (atBottom) this.scrollToEnd();
  }
}

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({
    title: "Terminal",
    width: 680,
    height: 440,
    minWidth: 360,
    minHeight: 220,
  });

  void handle.onCloseRequest(() => void os.process.exit(0));
  // An iframe app owns its whole document.
  const terminal = new Terminal(os, document.body);
  await os.process.onSignal("SIGTERM", () => terminal.dispose());
  await terminal.start();
}
