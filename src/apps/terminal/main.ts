import type { KernelInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import terminalHTML from "./terminal.html?raw";
import "./terminal.css";
import "../../ui/theme.css";

const SHELL_PATH = "/ProgramFiles/sh";
const MAX_CHARS = 200_000;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

class Terminal {
  private readonly os: KernelInterface;
  private readonly out: HTMLElement;
  private readonly input: HTMLInputElement;

  private readonly encoder = new TextEncoder();
  /** Streaming: a 4KB read can split a multi-byte sequence across chunks. */
  private readonly decoder = new TextDecoder();

  private readonly history: string[] = [];
  private historyIndex = 0;

  private master = -1;
  private disposed = false;

  public constructor(os: KernelInterface) {
    this.os = os;

    const handle = os.windows.create({
      title: "Terminal",
      width: 680,
      height: 440,
      minWidth: 360,
      minHeight: 220,
    });
    handle.onCloseRequest(() => os.process.exit(0));

    const root = htmlStringToTemplate(terminalHTML);
    handle.body.appendChild(root);

    this.out = selectElementFromTemplate(root, '[data-field="out"]');
    this.input = selectElementFromTemplate(root, '[data-field="input"]');

    this.bindInput();
    root.addEventListener("mouseup", () => {
      if (window.getSelection()?.isCollapsed !== false) this.input.focus();
    });
  }

  /** Everything that can fail lives here, so main() can report it. */
  public async start(): Promise<void> {
    const { master, slave } = await this.os.io.openpty();
    this.master = master;

    const shell = this.os.process.spawn(SHELL_PATH, [], {
      fds: { 0: slave, 1: slave, 2: slave },
    });

    // CRITICAL. Three entries in the child's table share one description, so
    // its refs is 3 — plus ours, 4. Until we drop ours, the slave end never
    // reaches zero, and the read loop below would never see EOF.
    await this.os.io.close(slave);

    void this.pump();
    void this.reap(shell);
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
        this.append(this.decoder.decode(chunk, { stream: true }));
      }
    } catch (error) {
      // EINTR is our own termination aborting the parked read — not a fault.
      if (errorCode(error) === "EINTR" || this.disposed) return;
      this.append(`\n[terminal: ${errorCode(error) ?? "error"}]\n`);
    }
  }

  private async reap(shell: number): Promise<void> {
    const termination = await this.os.process.wait(shell as never);
    if (this.disposed) return;

    this.append(`\n[${SHELL_PATH} exited with ${termination.code}]\n`);
    this.input.disabled = true;
    this.input.placeholder = "shell exited";
  }

  private bindInput(): void {
    this.input.addEventListener("keydown", (event) => {
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

      if (event.key === event.ctrlKey && event.key === "c") {
        event.preventDefault();
      }
    });
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

export async function main(os: KernelInterface): Promise<void> {
  const terminal = new Terminal(os);
  os.process.onSignal("SIGTERM", () => terminal.dispose());
  await terminal.start();
}
