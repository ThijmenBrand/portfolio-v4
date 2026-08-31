import type { KernelInterface } from "../../kernel/syscalls/api";
import type { Pid } from "../../kernel/types";

const SEARCH_PATH = ["", "/ProgramFiles/", "/System/"];

interface Redirect {
  path: string;
  append: boolean;
}

interface Command {
  argv: string[];
  stdin?: string;
  stdout?: Redirect;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Emits operators as their own tokens so `echo hi>f` splits the same way
 * as `echo hi > f`. Quotes suppress both splitting and operators.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  const flush = () => {
    if (current !== "" || quoted) tokens.push(current);
    current = "";
    quoted = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;

    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      if (end < 0) throw new Error("unterminated quote");
      current += line.slice(i + 1, end);
      quoted = true;
      i = end;
      continue;
    }

    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }

    if (ch === "|" || ch === "<" || ch === ">") {
      flush();
      if (ch === ">" && line[i + 1] === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }

    current += ch;
  }

  flush();
  return tokens;
}

function parse(tokens: string[]): Command[] {
  const commands: Command[] = [];
  let current: Command = { argv: [] };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token === "|") {
      if (current.argv.length === 0) throw new Error("syntax error near `|`");
      commands.push(current);
      current = { argv: [] };
      continue;
    }

    if (token === "<" || token === ">" || token === ">>") {
      const target = tokens[i + 1];
      if (target === undefined || ["|", "<", ">", ">>"].includes(target)) {
        throw new Error(`syntax error: \`${token}\` needs a filename`);
      }
      if (token === "<") current.stdin = target;
      else current.stdout = { path: target, append: token === ">>" };
      i += 1;
      continue;
    }

    current.argv.push(token);
  }

  if (current.argv.length > 0 || commands.length > 0) commands.push(current);
  if (commands.some((c) => c.argv.length === 0)) {
    throw new Error("syntax error: empty command");
  }
  return commands;
}

/** Reassembles lines from a byte stream that splits wherever it likes. */
class LineReader {
  private buffer = "";
  private eof = false;
  private readonly decoder = new TextDecoder();

  private readonly os: KernelInterface;
  private readonly fd: number;

  public constructor(os: KernelInterface, fd: number) {
    this.os = os;
    this.fd = fd;
  }

  public async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.eof) {
        const rest = this.buffer;
        this.buffer = "";
        return rest.length > 0 ? rest : null;
      }

      const chunk = await this.os.io.read(this.fd, 1024);
      if (chunk.length === 0) this.eof = true;
      else this.buffer += this.decoder.decode(chunk, { stream: true });
    }
  }
}

class Shell {
  private readonly encoder = new TextEncoder();
  private readonly lines: LineReader;
  private status = 0;
  private running = true;
  private foreground: Pid[] = [];

  private readonly os: KernelInterface;

  public constructor(os: KernelInterface) {
    this.os = os;
    this.lines = new LineReader(os, 0);
  }

  public async run(): Promise<number> {
    this.os.process.onSignal("SIGINT", () => this.interrupt());
    await this.write(1, "portfolio sh — try `help`\n");

    while (this.running) {
      await this.write(1, `${this.os.process.cwd()} $ `);

      const line = await this.lines.readLine();
      if (line === null) break; // stdin closed — the terminal went away

      const trimmed = line.trim();
      if (trimmed === "") continue;

      try {
        this.status = await this.execute(trimmed);
      } catch (error) {
        const code = errorCode(error);
        await this.write(2, `${code ? `${code}: ` : ""}${message(error)}\n`);
        this.status = 1;
      }
    }

    return this.status;
  }

  private interrupt(): void {
    // Idle at the prompt: bash redraws it. Nothing to kill.
    if (this.foreground.length === 0) {
      void this.write(1, `${this.os.process.cwd()} $ `);
      return;
    }

    for (const pid of this.foreground) {
      try {
        this.os.process.kill(pid, "SIGINT");
      } catch {
        // ESRCH — it exited between the signal and here.
      }
    }
  }

  private async execute(line: string): Promise<number> {
    const commands = parse(tokenize(line));

    if (commands.length === 1 && this.isBuiltin(commands[0]!.argv[0]!)) {
      return this.runBuiltin(commands[0]!);
    }
    if (commands.some((c) => this.isBuiltin(c.argv[0]!))) {
      throw new Error("builtins cannot appear in a pipeline");
    }
    return this.runPipeline(commands);
  }

  // ------------------------------------------------------------- builtins

  private isBuiltin(name: string): boolean {
    return ["cd", "pwd", "exit", "help"].includes(name);
  }

  private async runBuiltin(command: Command): Promise<number> {
    const [name, ...args] = command.argv;

    if (name === "pwd") {
      await this.write(1, `${this.os.process.cwd()}\n`);
      return 0;
    }

    if (name === "cd") {
      await this.os.process.chdir(args[0] ?? "/home");
      return 0;
    }

    if (name === "exit") {
      this.running = false;
      return args[0] === undefined ? this.status : Number(args[0]) || 0;
    }

    await this.write(
      1,
      [
        "builtins:  cd <dir>   pwd   exit [code]   help",
        "programs:  anything in /ProgramFiles or /System",
        "redirect:  cmd > file   cmd >> file   cmd < file",
        "pipeline:  cmd | cmd | cmd",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // ------------------------------------------------------------- external

  /**
   * binfmt is an exact-match table, so bare names need a search path.
   * spawn throws ENOENT synchronously, which makes "try each" cheap.
   */
  private spawn(command: Command, fds: Record<number, number>): Pid {
    const [name, ...args] = command.argv;
    let last: unknown;

    for (const prefix of SEARCH_PATH) {
      try {
        return this.os.process.spawn(`${prefix}${name}`, args, { fds });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        last = error;
      }
    }

    throw last ?? new Error(`${name}: not found`);
  }

  private async runPipeline(commands: Command[]): Promise<number> {
    const opened: number[] = [];
    const pids: Pid[] = [];

    try {
      const pipes: Array<{ read: number; write: number }> = [];
      for (let i = 0; i < commands.length - 1; i += 1) {
        const pipe = await this.os.io.pipe();
        pipes.push(pipe);
        opened.push(pipe.read, pipe.write);
      }

      for (let i = 0; i < commands.length; i += 1) {
        const command = commands[i]!;
        const fds: Record<number, number> = { 0: 0, 1: 1, 2: 2 };

        if (i > 0) fds[0] = pipes[i - 1]!.read;
        if (i < commands.length - 1) fds[1] = pipes[i]!.write;

        // An explicit redirect beats the pipe, exactly like a real shell.
        if (command.stdin) {
          const fd = await this.os.io.open(command.stdin, { read: true });
          opened.push(fd);
          fds[0] = fd;
        }
        if (command.stdout) {
          const fd = await this.os.io.open(command.stdout.path, {
            write: true,
            create: true,
            truncate: !command.stdout.append,
            append: command.stdout.append,
          });
          opened.push(fd);
          fds[1] = fd;
        }

        pids.push(this.spawn(command, fds));
      }
    } finally {
      // THE step that makes a pipeline terminate. Every pipe end the shell
      // still holds keeps writerCount above zero, so the downstream reader
      // would park on EOF forever.
      for (const fd of opened) await this.os.io.close(fd).catch(() => {});
    }

    this.foreground = pids;
    try {
      let status = 0;
      for (const pid of pids) status = (await this.os.process.wait(pid)).code;
      return status;
    } finally {
      this.foreground = [];
    }
  }

  private async write(fd: number, text: string): Promise<void> {
    try {
      await this.os.io.write(fd, this.encoder.encode(text));
    } catch (error) {
      if (errorCode(error) !== "EPIPE") throw error;
      this.running = false; // nobody is listening; stop cleanly
    }
  }
}

export async function main(os: KernelInterface): Promise<void> {
  const shell = new Shell(os);
  os.process.exit(await shell.run());
}
