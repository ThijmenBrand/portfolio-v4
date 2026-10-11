import { KernelError } from "../../kernel/errors";
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid, WaitStatus } from "../../kernel/types";

interface Redirect {
  path: string;
  append: boolean;
}

interface Command {
  argv: string[];
  stdin?: string;
  stdout?: Redirect;
}

/** A pipeline in its own process group, so the terminal can signal all of it. */
interface Job {
  id: number;
  pgid: Pid;
  pids: Pid[];
  last: Pid;
  command: string;
  status: number;
  state: "running" | "stopped" | "done";
  background: boolean;
  notify: boolean;
  monitor?: Promise<void>;
  waits: Map<Pid, Promise<{ pid: Pid; status: WaitStatus }>>;
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

const LITERAL_DOLLAR = "\0";

const VARIABLE = /\$(\?|\{\w+\}|[A-Za-z_]\w*)/g;

/**
 * Emits operators as their own tokens so `echo hi>f` splits the same way
 * as `echo hi > f`. Quotes suppress both splitting and operators.
 *
 * `$NAME` is left in place and expanded per command (see Shell.expand), so
 * `export X=1; echo $X` sees the new value. Inside '...' a `$` is stored as
 * NUL, which expand turns back into a literal `$`.
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
      const text = line.slice(i + 1, end);
      current += ch === "'" ? text.replaceAll("$", LITERAL_DOLLAR) : text;
      quoted = true;
      i = end;
      continue;
    }

    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }

    // ponytail: `&&` only splits at a word start, so `./&&` stays a filename.
    if (ch === "&" && line[i + 1] === "&" && current === "" && !quoted) {
      tokens.push("&&");
      i += 1;
      continue;
    }

    // A lone `&` runs what comes before it in the background.
    if (ch === "&" && line[i + 1] !== "&") {
      flush();
      tokens.push("&");
      continue;
    }

    if (ch === "|" || ch === "<" || ch === ">" || ch === ";") {
      flush();
      if (ch === ">" && line[i + 1] === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }

    if (
      ch === "~" &&
      current === "" &&
      !quoted &&
      /^$|^[\/\s;|<>&]/.test(line[i + 1] ?? "")
    ) {
      current += "$HOME";
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

  private readonly os: AppInterface;
  private readonly fd: number;

  public constructor(os: AppInterface, fd: number) {
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
  private status = 0;
  private running = true;
  private env: Record<string, string> = {};
  private root = false;

  private readonly jobs: Job[] = [];
  private foregroundJob?: Job;
  /** stdin is a terminal we control: hand it to each foreground job. */
  private tty = false;
  private pgid = 0 as Pid;

  private readonly os: AppInterface;

  public constructor(os: AppInterface) {
    this.os = os;
  }

  /** Interactive on stdin, or `sh script` runs the script and exits. */
  public async run(script?: string): Promise<number> {
    this.env = await this.os.process.env();
    this.root = (await this.os.process.ids()).euid === 0;
    if (script !== undefined) return this.source(script);

    await this.os.process.onSignal("SIGINT", () => void this.interrupt());
    // ^Z at the prompt reaches us too: the shell itself never stops.
    await this.os.process.onSignal("SIGTSTP", () => {});
    await this.takeTerminal();
    await this.write(1, "portfolio sh — try `help`\n");
    if (this.env.HOME) {
      await this.source(`${this.env.HOME}/.profile`).catch((error) => {
        const code = errorCode(error);
        if (code !== "ENOENT" && code !== "EACCES") throw error;
      });
    }
    const status = await this.runLines(new LineReader(this.os, 0), true);
    await this.hangUpStopped();
    return status;
  }

  /**
   * Our own session and group, then make it the terminal's foreground, so
   * ^C at the prompt reaches us and not whoever started us. Not a terminal
   * (stdin is a pipe): no job control, jobs still get their own groups.
   */
  private async takeTerminal(): Promise<void> {
    await this.os.process.setsid().catch(() => {}); // EPERM: already a group leader
    this.pgid = (await this.os.process.ids()).pgid;
    try {
      await this.os.io.tcsetpgrp(0, this.pgid);
      this.tty = true;
    } catch {
      this.tty = false;
    }
  }

  /** Stopped jobs would wait forever once we're gone: hang up and wake them. */
  private async hangUpStopped(): Promise<void> {
    for (const job of this.jobs) {
      if (job.state !== "stopped") continue;
      await this.os.process.kill(-job.pgid as Pid, "SIGHUP").catch(() => {});
      await this.os.process.kill(-job.pgid as Pid, "SIGCONT").catch(() => {});
    }
  }

  /** Runs a file's lines in this shell, so its `export`s stick (`source`). */
  private async source(path: string): Promise<number> {
    const fd = await this.os.io.open(path, { read: true });
    try {
      return await this.runLines(new LineReader(this.os, fd), false);
    } finally {
      await this.os.io.close(fd).catch(() => {});
    }
  }

  private async runLines(
    lines: LineReader,
    interactive: boolean,
  ): Promise<number> {
    while (this.running) {
      if (interactive) {
        await this.reportJobs();
        await this.prompt();
      }

      const line = await lines.readLine();
      if (line === null) break; // EOF: end of script, or the terminal went away

      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;

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

  private async prompt(): Promise<void> {
    // ponytail: the terminal sniffs the trailing "$ " / "# " to know sh is up.
    const user = this.env.USER ? `${this.env.USER}:` : "";
    const cwd = await this.os.process.cwd();
    await this.write(1, `${user}${cwd} ${this.root ? "#" : "$"} `);
  }

  private async interrupt(): Promise<void> {
    // Idle at the prompt: bash redraws it. Nothing to kill.
    if (!this.foregroundJob) {
      await this.prompt();
      return;
    }

    // Without a terminal, nobody else signals the job: pass it on.
    // (With one, ^C went straight to the job's group, not to us.)
    // ESRCH — it exited between the signal and here.
    await this.os.process
      .kill(-this.foregroundJob.pgid as Pid, "SIGINT")
      .catch(() => {});
  }

  /** `a && b` runs b only if a succeeded; `a ; b` always runs b; `a & b` doesn't wait for a. */
  private async execute(line: string): Promise<number> {
    const tokens = tokenize(line);
    let status = 0;
    let start = 0;
    let skip = false;

    for (let i = 0; i <= tokens.length; i += 1) {
      const token = tokens[i];
      if (token !== undefined && !["&&", ";", "&"].includes(token)) continue;

      const group = tokens.slice(start, i);
      if (group.length === 0 && token !== undefined) {
        throw new Error(`syntax error near \`${token}\``);
      }
      if (group.length > 0 && !skip) {
        status = await this.executeGroup(
          group.map((t) => this.expand(t)),
          token === "&",
        );
        this.status = status; // so `$?` in the next command sees it
      }
      skip = token === "&&" && status !== 0;
      start = i + 1;
    }
    return status;
  }

  private expand(token: string): string {
    return token
      .replace(VARIABLE, (_, name: string) =>
        name === "?"
          ? String(this.status)
          : (this.env[name.replace(/[{}]/g, "")] ?? ""),
      )
      .replaceAll(LITERAL_DOLLAR, "$");
  }

  private async executeGroup(
    tokens: string[],
    background: boolean,
  ): Promise<number> {
    const commands = parse(tokens);

    if (commands.length === 1 && this.isBuiltin(commands[0]!.argv[0]!)) {
      return this.runBuiltin(commands[0]!);
    }
    if (commands.some((c) => this.isBuiltin(c.argv[0]!))) {
      throw new Error("builtins cannot appear in a pipeline");
    }
    return this.runPipeline(commands, tokens.join(" "), background);
  }

  // ------------------------------------------------------------- builtins

  private isBuiltin(name: string): boolean {
    return [
      "cd",
      "pwd",
      "exit",
      "help",
      "export",
      "unset",
      "source",
      ".",
      "jobs",
      "fg",
      "bg",
    ].includes(name);
  }

  private async runBuiltin(command: Command): Promise<number> {
    const [name, ...args] = command.argv;

    if (name === "pwd") {
      await this.write(1, `${await this.os.process.cwd()}\n`);
      return 0;
    }

    if (name === "cd") {
      await this.os.process.chdir(args[0] ?? this.env.HOME ?? "/");
      return 0;
    }

    if (name === "export" || name === "unset") {
      for (const arg of args) {
        const eq = arg.indexOf("=");
        if (name === "unset") await this.os.process.setenv(arg);
        // `export NAME` alone: every variable is already exported here.
        else if (eq > 0)
          await this.os.process.setenv(arg.slice(0, eq), arg.slice(eq + 1));
      }
      this.env = await this.os.process.env();
      return 0;
    }

    if (name === "source" || name === ".") {
      if (args[0] === undefined) throw new Error(`${name}: needs a filename`);
      return this.source(args[0]);
    }

    if (name === "jobs") {
      for (const job of this.jobs) await this.write(1, this.jobLine(job));
      return 0;
    }

    if (name === "fg" || name === "bg") {
      const job = this.findJob(args[0]);
      if (!job)
        throw new Error(`${name}: ${args[0] ?? "current"}: no such job`);
      if (name === "fg") {
        await this.write(1, `${job.command}\n`);
        await this.os.process.kill(-job.pgid as Pid, "SIGCONT");
        return this.runForeground(job);
      }
      job.background = true;
      await this.os.process.kill(-job.pgid as Pid, "SIGCONT");
      await this.write(1, `[${job.id}]+ ${job.command} &\n`);
      this.watchBackground(job);
      return 0;
    }

    if (name === "exit") {
      this.running = false;
      return args[0] === undefined ? this.status : Number(args[0]) || 0;
    }

    await this.write(
      1,
      [
        "builtins:  cd <dir>   pwd   exit [code]   help   source <file>",
        "vars:      export NAME=value   unset NAME   env   echo $NAME \"$NAME\" '$NAME'",
        "files:     ls  cat  touch  mkdir [-p]  rmdir  rm [-r]  cp  mv",
        "text:      head  tail  wc  grep  sort  uniq  tee",
        "find:      tree  find [-name glob]  stat",
        "procs:     ps   kill [-SIGNAL] pid|-pgid   sleep N",
        "jobs:      cmd &   jobs   fg [%n]   bg [%n]   Ctrl-Z stops, Ctrl-C interrupts",
        "terminal:  stty [size | -a | [-]echo | [-]icanon | [-]isig]",
        "misc:      date  whoami  uname  open <url>",
        "programs:  anything on $PATH (export PATH=/home/bin:$PATH)",
        "scripts:   first line #!/ProgramFiles/sh, run by path or via $PATH",
        "startup:   $HOME/.profile is sourced when sh starts",
        "redirect:  cmd > file   cmd >> file   cmd < file",
        "pipeline:  cmd | cmd | cmd",
        "chain:     cmd && cmd (if ok)   cmd ; cmd (always)",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // ------------------------------------------------------------- external

  /**
   * binfmt is an exact-match table, so bare names are looked up on PATH.
   * spawn throws ENOENT synchronously, which makes "try each" cheap.
   */
  private async spawn(
    command: Command,
    fds: Record<number, number>,
    pgid: number,
  ): Promise<Pid> {
    const [name, ...args] = command.argv;

    // An explicit path is run as given, and keeps its real error.
    if (name.includes("/")) {
      return await this.os.process.spawn(name, args, { fds, pgid });
    }

    for (const dir of (this.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        return await this.os.process.spawn(`${dir}/${name}`, args, {
          fds,
          pgid,
        });
      } catch (error) {
        // Not here, or a PATH entry that isn't a directory: try the next.
        if (!["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
          throw error;
      }
    }

    throw new KernelError("ENOENT", `${name}: command not found`);
  }

  private async runPipeline(
    commands: Command[],
    text: string,
    background: boolean,
  ): Promise<number> {
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

        // The first command leads a new group; the rest join it.
        pids.push(await this.spawn(command, fds, pids[0] ?? 0));
      }
    } finally {
      // THE step that makes a pipeline terminate. Every pipe end the shell
      // still holds keeps writerCount above zero, so the downstream reader
      // would park on EOF forever.
      for (const fd of opened) await this.os.io.close(fd).catch(() => {});
    }

    const job: Job = {
      id: Math.max(0, ...this.jobs.map((j) => j.id)) + 1, // like bash: [1] again once [1] is gone
      pgid: pids[0]!,
      pids,
      last: pids[pids.length - 1]!,
      command: text,
      status: 0,
      state: "running",
      background,
      notify: false,
      waits: new Map(),
    };
    this.jobs.push(job);

    if (!background) return this.runForeground(job);
    await this.write(1, `[${job.id}] ${job.pgid}\n`);
    this.watchBackground(job);
    return 0;
  }

  // ------------------------------------------------------------- jobs

  /** Give the job the terminal until it exits or stops, then take it back. */
  private async runForeground(job: Job): Promise<number> {
    job.background = false;
    this.foregroundJob = job;
    if (this.tty) await this.os.io.tcsetpgrp(0, job.pgid).catch(() => {});
    try {
      await this.monitor(job);
    } finally {
      this.foregroundJob = undefined;
      if (this.tty) await this.os.io.tcsetpgrp(0, this.pgid).catch(() => {});
    }

    if (job.state === "stopped") await this.write(1, this.jobLine(job));
    else this.forget(job);
    return job.status;
  }

  private watchBackground(job: Job): void {
    void this.monitor(job).then(
      () => {
        if (job.background) job.notify = true;
      },
      () => {},
    );
  }

  /** Bash prints these just before the prompt, not in the middle of output. */
  private async reportJobs(): Promise<void> {
    for (const job of [...this.jobs]) {
      if (!job.notify) continue;
      job.notify = false;
      await this.write(1, this.jobLine(job));
      if (job.state === "done") this.forget(job);
    }
  }

  private monitor(job: Job): Promise<void> {
    job.monitor ??= this.waitJob(job).finally(() => {
      job.monitor = undefined;
    });
    return job.monitor;
  }

  /** Until every process is gone, or one stops (^Z stops the whole group). */
  private async waitJob(job: Job): Promise<void> {
    job.state = "running";
    while (job.pids.length > 0) {
      const { pid, status } = await Promise.race(
        job.pids.map((pid) => this.waitPid(job, pid)),
      );
      if (status.reason === "stopped") {
        job.state = "stopped";
        job.status = status.code;
        return;
      }
      job.pids = job.pids.filter((p) => p !== pid);
      if (pid === job.last) job.status = status.code;
    }
    job.state = "done";
  }

  private waitPid(
    job: Job,
    pid: Pid,
  ): Promise<{ pid: Pid; status: WaitStatus }> {
    let pending = job.waits.get(pid);
    if (!pending) {
      pending = this.os.process
        .wait(pid, { untraced: true })
        // ESRCH: already reaped. Count it as gone.
        .catch((): WaitStatus => ({ code: 1, reason: "crash", at: Date.now() }))
        .then((status) => {
          job.waits.delete(pid);
          return { pid, status };
        });
      job.waits.set(pid, pending);
    }
    return pending;
  }

  /** `%2`, `2`, or nothing for the most recent. */
  private findJob(spec?: string): Job | undefined {
    if (spec === undefined) return this.jobs[this.jobs.length - 1];
    const id = Number(spec.replace(/^%/, ""));
    return this.jobs.find((job) => job.id === id);
  }

  private forget(job: Job): void {
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
  }

  private jobLine(job: Job): string {
    const state = { running: "Running", stopped: "Stopped", done: "Done" }[
      job.state
    ];
    return `[${job.id}]  ${state.padEnd(22)}${job.command}\n`;
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

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const shell = new Shell(os);
  os.process.exit(await shell.run(args[0]));
}
