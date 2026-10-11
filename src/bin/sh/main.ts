import { KernelError } from "../../kernel/errors";
import type { AppInterface } from "../../kernel/syscalls/api";
import type { Pid, WaitStatus } from "../../kernel/types";
import {
  arith,
  assignment,
  escapeGlob,
  globToRegExp,
  hasGlob,
  Incomplete,
  parse,
  unescapeGlob,
  type Command,
  type List,
  type Pipeline,
  type Redirect,
  type Word,
} from "./syntax";

/** The shell fds that act as a command's stdin, stdout and stderr. */
type Io = readonly [number, number, number];
const STDIO: Io = [0, 1, 2];

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
  /** A process of it died of ^C: the rest of the line is abandoned, like bash. */
  interrupted: boolean;
  monitor?: Promise<void>;
  waits: Map<Pid, Promise<{ pid: Pid; status: WaitStatus }>>;
}

/** One element of a pipeline, ready to run. */
type Step =
  | { kind: "external"; argv: string[]; env: Record<string, string>; redirects: Redirect[] }
  | { kind: "shell"; run: (io: Io) => Promise<number> };

/** A word after expansion, before globbing: `pat` has quoted glob chars escaped. */
interface Field {
  text: string;
  pat: string;
  glob: boolean;
  exists: boolean;
}

// Control flow, thrown through the tree of runList/runCommand calls.
class Exit {
  public readonly code: number;
  public constructor(code: number) {
    this.code = code;
  }
}
class Return {
  public readonly code: number;
  public constructor(code: number) {
    this.code = code;
  }
}
class LoopJump {
  public levels: number;
  /** continue, not break */
  public readonly next: boolean;
  public constructor(levels: number, next: boolean) {
    this.levels = levels;
    this.next = next;
  }
}
class Interrupt {}

const BUILTINS = new Set([
  "cd", "pwd", "exit", "help", "export", "unset", "source", ".", "jobs", "fg", "bg",
  ":", "true", "false", "echo", "test", "[", "read", "shift", "local", "return",
  "break", "continue",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private readonly decoder = new TextDecoder();
  private status = 0;
  private running = true;
  /** Exported variables (the process environment) and shell-only ones. */
  private env: Record<string, string> = {};
  private vars: Record<string, string> = {};
  private name = "sh";
  private args: string[] = [];
  private readonly functions = new Map<string, Command>();
  /** One frame per running function: what `local` saved, to restore on return. */
  private readonly locals: Map<string, string | undefined>[] = [];
  private loops = 0;
  private root = false;

  private readonly jobs: Job[] = [];
  private foregroundJob?: Job;
  /** ^C arrived while the shell itself was busy (a loop of builtins). */
  private sigint = false;
  private busy = false;
  /** stdin is a terminal we control: hand it to each foreground job. */
  private tty = false;
  private pgid = 0 as Pid;

  private readonly os: AppInterface;

  public constructor(os: AppInterface) {
    this.os = os;
  }

  /** Interactive on stdin, or `sh script args…` runs the script and exits. */
  public async run(script?: string, args: string[] = []): Promise<number> {
    this.env = await this.os.process.env();
    this.root = (await this.os.process.ids()).euid === 0;
    try {
      if (script !== undefined) {
        this.name = script;
        this.args = args;
        return await this.source(script);
      }

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
      return await this.runLines(new LineReader(this.os, 0), true);
    } catch (error) {
      if (error instanceof Exit) return error.code;
      throw error;
    } finally {
      await this.hangUpStopped();
    }
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

  /** Runs a file in this shell, so its variables and functions stick (`source`). */
  private async source(path: string): Promise<number> {
    const fd = await this.os.io.open(path, { read: true });
    try {
      return await this.runLines(new LineReader(this.os, fd), false);
    } catch (error) {
      if (error instanceof Return) return error.code; // `return` ends a sourced file
      throw error;
    } finally {
      await this.os.io.close(fd).catch(() => {});
    }
  }

  /**
   * Read, parse, run. Lines collect until they parse: an open `if`, quote
   * or trailing `|` asks for more (with a `> ` prompt when interactive).
   */
  private async runLines(lines: LineReader, interactive: boolean): Promise<number> {
    let pending = "";
    while (this.running) {
      if (interactive) {
        if (pending === "") {
          await this.reportJobs();
          await this.prompt();
        } else {
          await this.write(1, "> ");
        }
      }

      const line = await lines.readLine();
      if (line === null) {
        if (pending.trim()) await this.write(2, "sh: syntax error: unexpected end of file\n");
        break; // EOF: end of script, or the terminal went away
      }

      pending += `${line}\n`;
      let list: List;
      try {
        list = parse(pending);
      } catch (error) {
        if (error instanceof Incomplete) continue;
        pending = "";
        await this.write(2, `sh: ${message(error)}\n`);
        this.status = 2;
        continue;
      }
      pending = "";

      this.busy = true;
      this.sigint = false;
      try {
        this.status = await this.runList(list, STDIO);
      } catch (error) {
        if (error instanceof Exit) throw error;
        if (error instanceof Interrupt) {
          this.status = 130;
        } else if (error instanceof Return || error instanceof LoopJump) {
          // `return` / `break` outside a function / loop: ignored, like bash.
        } else {
          const code = errorCode(error);
          await this.write(2, `${code ? `${code}: ` : ""}${message(error)}\n`);
          this.status = 1;
        }
      } finally {
        this.busy = false;
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
    if (!this.foregroundJob) {
      // Busy in the shell itself (a loop of builtins): stop at the next check.
      if (this.busy) this.sigint = true;
      // Idle at the prompt: bash redraws it. Nothing to kill.
      else await this.prompt();
      return;
    }

    // Without a terminal, nobody else signals the job: pass it on.
    // (With one, ^C went straight to the job's group, not to us.)
    // ESRCH — it exited between the signal and here.
    await this.os.process
      .kill(-this.foregroundJob.pgid as Pid, "SIGINT")
      .catch(() => {});
  }

  // ------------------------------------------------------------- running

  private async runList(list: List, io: Io): Promise<number> {
    let status = this.status;
    for (const { andOr, background } of list.items) {
      if (background) {
        if (andOr.rest.length > 0) throw new Error("&: only a single pipeline can run in the background");
        status = await this.runPipeline(andOr.first, io, true);
        this.status = status;
        continue;
      }
      status = await this.runPipeline(andOr.first, io, false);
      this.status = status; // so `$?` in the next command sees it
      for (const { op, pipeline } of andOr.rest) {
        if ((op === "&&") !== (status === 0)) continue;
        status = await this.runPipeline(pipeline, io, false);
        this.status = status;
      }
    }
    return status;
  }

  /**
   * External commands are spawned, wired with pipes. Builtins, functions and
   * compound commands run here, in the shell, with their own Io, so they can
   * sit anywhere in a pipeline (`cat f | while read l; do …; done`).
   */
  private async runPipeline(pipeline: Pipeline, io: Io, background: boolean): Promise<number> {
    const steps: Step[] = [];
    for (const cmd of pipeline.cmds) steps.push(await this.prepare(cmd));
    if (background && steps.some((step) => step.kind === "shell")) {
      throw new Error("&: only external commands can run in the background");
    }

    const n = steps.length;
    const pids: Pid[] = [];
    const shellRuns: Promise<number>[] = [];
    let lastShell: Promise<number> | undefined;
    const opened: number[] = [];

    try {
      const pipes: Array<{ read: number; write: number }> = [];
      for (let i = 0; i < n - 1; i += 1) {
        const pipe = await this.os.io.pipe();
        pipes.push(pipe);
        opened.push(pipe.read, pipe.write);
      }

      for (let i = 0; i < n; i += 1) {
        const step = steps[i]!;
        const stepIo: Io = [
          i > 0 ? pipes[i - 1]!.read : io[0],
          i < n - 1 ? pipes[i]!.write : io[1],
          io[2],
        ];
        // The pipe ends this step owns: the shell's copies close when it's done.
        const own = [i > 0 ? pipes[i - 1]!.read : -1, i < n - 1 ? pipes[i]!.write : -1].filter((fd) => fd >= 0);
        const release = async () => {
          for (const fd of own) {
            if (opened.includes(fd)) opened.splice(opened.indexOf(fd), 1);
            await this.os.io.close(fd).catch(() => {});
          }
        };

        if (step.kind === "external") {
          const fds = await this.redirect(step.redirects, stepIo, opened);
          // The first command leads a new group; the rest join it.
          pids.push(await this.spawn(step.argv, { 0: fds[0], 1: fds[1], 2: fds[2] }, pids[0] ?? 0, step.env));
          await release();
        } else {
          const run = this.runStep(step, stepIo).finally(release);
          shellRuns.push(run);
          if (i === n - 1) lastShell = run;
        }
      }
      await Promise.all(shellRuns);
    } finally {
      // THE step that makes a pipeline terminate. Every pipe end the shell
      // still holds keeps writerCount above zero, so the downstream reader
      // would park on EOF forever.
      for (const fd of opened) await this.os.io.close(fd).catch(() => {});
    }

    let status = lastShell ? await lastShell : 0;
    if (pids.length > 0) {
      const job: Job = {
        id: Math.max(0, ...this.jobs.map((j) => j.id)) + 1, // like bash: [1] again once [1] is gone
        pgid: pids[0]!,
        pids,
        last: pids[pids.length - 1]!,
        command: this.describe(steps),
        status: 0,
        state: "running",
        background,
        notify: false,
        interrupted: false,
        waits: new Map(),
      };
      this.jobs.push(job);

      if (background) {
        await this.write(io[1], `[${job.id}] ${job.pgid}\n`);
        this.watchBackground(job);
        return 0;
      }
      const jobStatus = await this.runForeground(job);
      if (job.interrupted) throw new Interrupt();
      if (!lastShell) status = jobStatus;
    }
    return pipeline.bang ? Number(status === 0) : status;
  }

  /** A shell step; a closed pipe downstream (EPIPE) just ends it, like SIGPIPE. */
  private async runStep(step: Step & { kind: "shell" }, io: Io): Promise<number> {
    try {
      return await step.run(io);
    } catch (error) {
      if (errorCode(error) === "EPIPE") return 141;
      throw error;
    }
  }

  private describe(steps: Step[]): string {
    return steps.map((s) => (s.kind === "external" ? s.argv.join(" ") : "…")).join(" | ");
  }

  /** Expand a simple command now; decide where it runs. */
  private async prepare(cmd: Command): Promise<Step> {
    if (cmd.t !== "simple") return { kind: "shell", run: (io) => this.runCommand(cmd, io) };

    const argv = await this.declarationArgs(cmd.words) ?? await this.expandWords(cmd.words, STDIO);
    const assigns: [string, string][] = [];
    for (const { name, value } of cmd.assigns) {
      assigns.push([name, await this.expandValue(value, STDIO)]);
    }

    if (argv.length === 0) {
      // `X=1` alone sets it; a bare `> file` creates/truncates the file.
      return {
        kind: "shell",
        run: async (io) => {
          for (const [name, value] of assigns) await this.setVar(name, value);
          await this.withRedirects(cmd.redirects, io, async () => 0);
          return 0;
        },
      };
    }

    const [name, ...args] = argv as [string, ...string[]];
    const body = this.functions.get(name);
    if (body) {
      return {
        kind: "shell",
        run: (io) => this.withRedirects(cmd.redirects, io, (io) => this.callFunction(body, args, io)),
      };
    }
    if (BUILTINS.has(name)) {
      return {
        kind: "shell",
        run: (io) => this.withRedirects(cmd.redirects, io, (io) => this.runBuiltin(name, args, io)),
      };
    }
    return { kind: "external", argv, env: Object.fromEntries(assigns), redirects: cmd.redirects };
  }

  private async runCommand(cmd: Command, io: Io): Promise<number> {
    switch (cmd.t) {
      case "simple": {
        // Only reached via a function/group body: run it as a pipeline of one.
        return this.runPipeline({ bang: false, cmds: [cmd] }, io, false);
      }
      case "func":
        this.functions.set(cmd.name, cmd.body);
        return 0;
      case "group":
        return this.withRedirects(cmd.redirects, io, (io) => this.runList(cmd.body, io));
      case "if":
        return this.withRedirects(cmd.redirects, io, async (io) => {
          for (const { cond, body } of cmd.clauses) {
            if ((await this.runList(cond, io)) === 0) return this.runList(body, io);
          }
          return cmd.otherwise ? this.runList(cmd.otherwise, io) : 0;
        });
      case "while":
        return this.withRedirects(cmd.redirects, io, (io) =>
          this.loop(async () => ((await this.runList(cmd.cond, io)) === 0) !== cmd.until, cmd.body, io),
        );
      case "for":
        return this.withRedirects(cmd.redirects, io, async (io) => {
          const items = cmd.words ? await this.expandWords(cmd.words, io) : [...this.args];
          let i = 0;
          return this.loop(
            async () => {
              if (i >= items.length) return false;
              await this.setVar(cmd.name, items[i++]!);
              return true;
            },
            cmd.body,
            io,
          );
        });
    }
  }

  private async loop(next: () => Promise<boolean>, body: List, io: Io): Promise<number> {
    let status = 0;
    this.loops += 1;
    try {
      for (let round = 1; await next(); round += 1) {
        // Let a ^C (a message from the kernel) in, even in a loop of builtins.
        if (round % 32 === 0) await new Promise((resolve) => setTimeout(resolve));
        if (this.sigint) throw new Interrupt();
        try {
          status = await this.runList(body, io);
        } catch (error) {
          if (!(error instanceof LoopJump)) throw error;
          if (--error.levels > 0) throw error;
          if (!error.next) break;
        }
      }
    } finally {
      this.loops -= 1;
    }
    return status;
  }

  private async callFunction(body: Command, args: string[], io: Io): Promise<number> {
    const saved = this.args;
    const loops = this.loops;
    this.args = args;
    this.loops = 0; // break/continue don't reach the caller's loops
    this.locals.push(new Map());
    try {
      return await this.runCommand(body, io);
    } catch (error) {
      if (error instanceof Return) return error.code;
      throw error;
    } finally {
      this.args = saved;
      this.loops = loops;
      for (const [name, value] of this.locals.pop()!) {
        if (value === undefined) delete this.vars[name];
        else this.vars[name] = value;
      }
    }
  }

  // ------------------------------------------------------------- redirects

  /**
   * Apply redirects on top of `io`. Opened files go in `opened`; the caller
   * closes them. `2>&1` copies whatever fd 1 is at that point, like sh.
   */
  private async redirect(redirects: Redirect[], io: Io, opened: number[]): Promise<Io> {
    const fds: [number, number, number] = [...io];
    for (const r of redirects) {
      if (r.fd > 2) throw new Error(`${r.fd}${r.op}: only fds 0, 1 and 2 can be redirected`);
      const target = await this.expandValue(r.target, io);
      if (r.op === ">&") {
        const from = Number(target);
        if (!/^[0-2]$/.test(target)) throw new Error(`>&${target}: only fds 0, 1 and 2`);
        fds[r.fd] = fds[from]!;
        continue;
      }
      const fd = await this.os.io.open(
        target,
        r.op === "<"
          ? { read: true }
          : { write: true, create: true, truncate: r.op === ">", append: r.op === ">>" },
      );
      opened.push(fd);
      fds[r.fd] = fd;
    }
    return fds;
  }

  private async withRedirects(
    redirects: Redirect[],
    io: Io,
    run: (io: Io) => Promise<number>,
  ): Promise<number> {
    if (redirects.length === 0) return run(io);
    const opened: number[] = [];
    try {
      return await run(await this.redirect(redirects, io, opened));
    } finally {
      for (const fd of opened) await this.os.io.close(fd).catch(() => {});
    }
  }

  // ------------------------------------------------------------- expansion

  private lookup(name: string): string {
    if (name === "?") return String(this.status);
    if (name === "#") return String(this.args.length);
    if (name === "@" || name === "*") return this.args.join(" ");
    if (name === "$") return String(this.os.process.pid);
    if (name === "0") return this.name;
    if (/^\d+$/.test(name)) return this.args[Number(name) - 1] ?? "";
    return this.vars[name] ?? this.env[name] ?? "";
  }

  /** Exported names stay exported (the environment); others are shell-only. */
  private async setVar(name: string, value: string): Promise<void> {
    if (name in this.env) {
      await this.os.process.setenv(name, value);
      this.env[name] = value;
    } else {
      this.vars[name] = value;
    }
  }

  /** Words -> argv: expand, split unquoted results, glob. */
  private async expandWords(words: Word[], io: Io): Promise<string[]> {
    const argv: string[] = [];
    for (const word of words) {
      for (const field of await this.fields(word, io)) {
        const matches = field.glob ? await this.glob(field.pat) : [];
        if (matches.length > 0) argv.push(...matches);
        else argv.push(field.glob ? unescapeGlob(field.pat) : field.text);
      }
    }
    return argv;
  }

  /**
   * `local x=$1` / `export x=$1`: like bash, NAME=value arguments of these
   * are expanded as assignments (no splitting). Null for other commands.
   */
  private async declarationArgs(words: Word[]): Promise<string[] | null> {
    const [first, ...rest] = words;
    const name = first?.length === 1 && first[0]!.k === "lit" && !first[0]!.q ? first[0]!.v : "";
    if (name !== "local" && name !== "export") return null;
    const argv = [name];
    for (const word of rest) {
      const assign = assignment(word);
      if (assign) argv.push(`${assign.name}=${await this.expandValue(assign.value, STDIO)}`);
      else argv.push(...(await this.expandWords([word], STDIO)));
    }
    return argv;
  }

  /** An assignment value or redirect target: one string, never split or globbed. */
  private async expandValue(word: Word, io: Io): Promise<string> {
    let text = "";
    for (const seg of word) text += seg.k === "lit" ? seg.v : await this.segValue(seg, io);
    return text;
  }

  private async segValue(seg: Exclude<Word[number], { k: "lit" }>, io: Io): Promise<string> {
    if (seg.k === "var") return this.lookup(seg.name);
    if (seg.k === "cmd") return this.capture(seg.src, io);
    const expr = seg.src.replace(/\$\{?([A-Za-z_]\w*|[0-9?#])\}?/g, (_, name: string) => this.lookup(name));
    return String(arith(expr, (name) => this.lookup(name)));
  }

  /**
   * Unquoted expansions split on blanks; quoted ones never do. "$@" is one
   * field per argument. A field exists once it has text or a quoted part,
   * so "" is an (empty) argument and an unset $X is none.
   */
  private async fields(word: Word, io: Io): Promise<Field[]> {
    const out: Field[] = [];
    let field: Field = { text: "", pat: "", glob: false, exists: false };
    const end = () => {
      if (field.exists) out.push(field);
      field = { text: "", pat: "", glob: false, exists: false };
    };
    const add = (text: string, quoted: boolean, globbable: boolean) => {
      field.text += text;
      field.pat += globbable ? text : escapeGlob(text);
      if (globbable && hasGlob(text)) field.glob = true;
      if (quoted || text) field.exists = true;
    };

    for (const seg of word) {
      if (seg.k === "lit") {
        add(seg.v, seg.q, !seg.q);
      } else if (seg.k === "var" && seg.name === "@" && seg.q) {
        this.args.forEach((arg, i) => {
          if (i > 0) end();
          add(arg, true, false);
        });
      } else {
        const value = await this.segValue(seg, io);
        if (seg.q) add(value, true, false);
        else
          value.split(/[ \t\n]+/).forEach((piece, i) => {
            if (i > 0) end();
            add(piece, false, false);
          });
      }
    }
    end();
    return out;
  }

  /** `$(…)`: run it with stdout on a pipe; its output, minus trailing newlines. */
  private async capture(src: string, io: Io): Promise<string> {
    let list: List;
    try {
      list = parse(src);
    } catch (error) {
      throw new Error(`$(${src}): ${message(error)}`);
    }
    const pipe = await this.os.io.pipe();
    const reading = this.readAll(pipe.read);
    try {
      await this.runList(list, [io[0], pipe.write, io[2]]);
    } finally {
      await this.os.io.close(pipe.write).catch(() => {});
    }
    const output = await reading;
    await this.os.io.close(pipe.read).catch(() => {});
    return output.replace(/\n+$/, "");
  }

  private async readAll(fd: number): Promise<string> {
    let text = "";
    for (;;) {
      const chunk = await this.os.io.read(fd, 4096);
      if (chunk.length === 0) return text + this.decoder.decode();
      text += this.decoder.decode(chunk, { stream: true });
    }
  }

  /** Paths matching `pattern` (\-escaped literals), sorted; [] when none. */
  private async glob(pattern: string): Promise<string[]> {
    const cwd = await this.os.process.cwd();
    const segments = pattern.split("/");
    let matches = [pattern.startsWith("/") ? "/" : ""];
    const join = (prefix: string, name: string) =>
      prefix === "" ? name : prefix.endsWith("/") ? prefix + name : `${prefix}/${name}`;

    for (const segment of segments) {
      if (segment === "") continue;
      const next: string[] = [];
      for (const prefix of matches) {
        if (!hasGlob(segment)) {
          next.push(join(prefix, unescapeGlob(segment)));
          continue;
        }
        const dir = prefix === "" ? cwd : prefix.startsWith("/") ? prefix : `${cwd}/${prefix}`;
        const entries = await this.os.fs.readdir(dir).catch(() => []);
        const re = globToRegExp(segment);
        const dotted = unescapeGlob(segment).startsWith(".");
        for (const entry of entries) {
          if (entry.name.startsWith(".") && !dotted) continue; // like sh: * skips dotfiles
          if (re.test(entry.name)) next.push(join(prefix, entry.name));
        }
      }
      matches = next;
    }
    // A literal part after the last glob (`*/main.js`) must exist too.
    if (!hasGlob(segments[segments.length - 1] ?? "")) {
      const exists = await Promise.all(
        matches.map((path) => this.os.fs.stat(path).then(() => true, () => false)),
      );
      matches = matches.filter((_, i) => exists[i]);
    }
    return matches.sort();
  }

  // ------------------------------------------------------------- builtins

  private async runBuiltin(name: string, args: string[], io: Io): Promise<number> {
    const out = (text: string) => this.write(io[1], text);

    switch (name) {
      case ":":
      case "true":
        return 0;
      case "false":
        return 1;

      case "echo": {
        const newline = args[0] !== "-n";
        await out(`${(newline ? args : args.slice(1)).join(" ")}${newline ? "\n" : ""}`);
        return 0;
      }

      case "test":
      case "[": {
        if (name === "[") {
          if (args[args.length - 1] !== "]") throw new Error("[: missing ]");
          args = args.slice(0, -1);
        }
        return (await this.test(args)) ? 0 : 1;
      }

      case "read":
        return this.read(args.filter((a) => a !== "-r"), io[0]);

      case "pwd":
        await out(`${await this.os.process.cwd()}\n`);
        return 0;

      case "cd":
        await this.os.process.chdir(args[0] ?? this.env.HOME ?? "/");
        return 0;

      case "export":
      case "unset":
        for (const arg of args) {
          const eq = arg.indexOf("=");
          if (name === "unset") {
            delete this.vars[arg];
            await this.os.process.setenv(arg);
          } else if (eq > 0) {
            await this.os.process.setenv(arg.slice(0, eq), arg.slice(eq + 1));
            delete this.vars[arg.slice(0, eq)];
          } else if (arg in this.vars) {
            // `X=1; export X`: move it into the environment.
            await this.os.process.setenv(arg, this.vars[arg]!);
            delete this.vars[arg];
          }
        }
        this.env = await this.os.process.env();
        return 0;

      case "local": {
        const frame = this.locals[this.locals.length - 1];
        if (!frame) throw new Error("local: only inside a function");
        for (const arg of args) {
          const eq = arg.indexOf("=");
          const key = eq > 0 ? arg.slice(0, eq) : arg;
          if (!frame.has(key)) frame.set(key, this.vars[key]);
          this.vars[key] = eq > 0 ? arg.slice(eq + 1) : "";
        }
        return 0;
      }

      case "shift": {
        const n = Number(args[0] ?? 1);
        if (!Number.isInteger(n) || n < 0 || n > this.args.length) return 1;
        this.args = this.args.slice(n);
        return 0;
      }

      case "return": // ends a function or a sourced file; ignored at the prompt
        throw new Return(args[0] === undefined ? this.status : Number(args[0]) || 0);

      case "break":
      case "continue": {
        if (this.loops === 0) throw new Error(`${name}: only inside a loop`);
        const levels = Math.min(Math.max(1, Number(args[0] ?? 1) || 1), this.loops);
        throw new LoopJump(levels, name === "continue");
      }

      case "exit":
        this.running = false;
        throw new Exit(args[0] === undefined ? this.status : Number(args[0]) || 0);

      case "source":
      case ".":
        if (args[0] === undefined) throw new Error(`${name}: needs a filename`);
        return this.source(args[0]);

      case "jobs":
        for (const job of this.jobs) await out(this.jobLine(job));
        return 0;

      case "fg":
      case "bg": {
        const job = this.findJob(args[0]);
        if (!job) throw new Error(`${name}: ${args[0] ?? "current"}: no such job`);
        if (name === "fg") {
          await out(`${job.command}\n`);
          await this.os.process.kill(-job.pgid as Pid, "SIGCONT");
          return this.runForeground(job);
        }
        job.background = true;
        await this.os.process.kill(-job.pgid as Pid, "SIGCONT");
        await out(`[${job.id}]+ ${job.command} &\n`);
        this.watchBackground(job);
        return 0;
      }
    }

    await out(HELP);
    return 0;
  }

  /** `read [-r] [name…]`: one line from stdin; the last name gets the rest. */
  private async read(names: string[], fd: number): Promise<number> {
    const line = await this.readLineFrom(fd);
    if (line === null) return 1;
    const targets = names.length > 0 ? names : ["REPLY"];
    let rest = names.length > 0 ? line.trim() : line;
    for (const [i, name] of targets.entries()) {
      if (i === targets.length - 1) {
        await this.setVar(name, rest);
        break;
      }
      const match = /^(\S*)\s*/.exec(rest)!;
      await this.setVar(name, match[1]!);
      rest = rest.slice(match[0].length);
    }
    return 0;
  }

  /**
   * Exactly one line, leaving the rest for whoever reads `fd` next. A file
   * can be read ahead and seeked back; a pipe or terminal only byte by byte.
   */
  private async readLineFrom(fd: number): Promise<string | null> {
    const seekable = (await this.os.io.fstat(fd).catch(() => null))?.kind === "file";
    const bytes: number[] = [];
    for (;;) {
      const chunk = await this.os.io.read(fd, seekable ? 1024 : 1);
      if (chunk.length === 0) {
        return bytes.length > 0 ? this.decoder.decode(new Uint8Array(bytes)) : null;
      }
      const newline = chunk.indexOf(10);
      if (newline < 0) {
        bytes.push(...chunk);
        continue;
      }
      bytes.push(...chunk.subarray(0, newline));
      const extra = chunk.length - newline - 1;
      if (extra > 0) await this.os.io.seek(fd, -extra, "cur");
      return this.decoder.decode(new Uint8Array(bytes));
    }
  }

  /** test / [ : the common POSIX subset. */
  private async test(args: string[]): Promise<boolean> {
    if (args[0] === "!") return !(await this.test(args.slice(1)));
    if (args.length === 0) return false;
    if (args.length === 1) return args[0] !== "";

    if (args.length === 2) {
      const [op, value] = args as [string, string];
      if (op === "-n") return value !== "";
      if (op === "-z") return value === "";
      const stat = await this.os.fs.stat(value).catch(() => null);
      switch (op) {
        case "-e": return stat !== null;
        case "-f": return stat?.kind === "file";
        case "-d": return stat?.kind === "directory";
        case "-p": return stat?.kind === "fifo";
        case "-s": return (stat?.size ?? 0) > 0;
      }
      throw new Error(`test: unknown operator ${op}`);
    }

    if (args.length === 3) {
      const [a, op, b] = args as [string, string, string];
      switch (op) {
        case "=":
        case "==": return a === b;
        case "!=": return a !== b;
      }
      const x = Number(a);
      const y = Number(b);
      if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(op)) {
        if (!Number.isInteger(x) || !Number.isInteger(y) || a.trim() === "" || b.trim() === "") {
          throw new Error(`test: integer expected: ${Number.isInteger(x) ? b : a}`);
        }
      }
      switch (op) {
        case "-eq": return x === y;
        case "-ne": return x !== y;
        case "-lt": return x < y;
        case "-le": return x <= y;
        case "-gt": return x > y;
        case "-ge": return x >= y;
      }
      throw new Error(`test: unknown operator ${op}`);
    }
    throw new Error("test: too many arguments (combine tests with && and ||)");
  }

  // ------------------------------------------------------------- external

  /**
   * binfmt is an exact-match table, so bare names are looked up on PATH.
   * spawn throws ENOENT synchronously, which makes "try each" cheap.
   */
  private async spawn(
    argv: string[],
    fds: Record<number, number>,
    pgid: number,
    env: Record<string, string>,
  ): Promise<Pid> {
    const [name, ...args] = argv as [string, ...string[]];
    const options = { fds, pgid, ...(Object.keys(env).length > 0 ? { env } : {}) };

    // An explicit path is run as given, and keeps its real error.
    if (name.includes("/")) {
      return await this.os.process.spawn(name, args, options);
    }

    for (const dir of (this.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        return await this.os.process.spawn(`${dir}/${name}`, args, options);
      } catch (error) {
        // Not here, or a PATH entry that isn't a directory: try the next.
        if (!["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
          throw error;
      }
    }

    throw new KernelError("ENOENT", `${name}: command not found`);
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
      if (status.reason === "signal" && status.signal === "SIGINT") job.interrupted = true;
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

  /**
   * EPIPE on the shell's own stdout: nobody is listening, stop cleanly. On
   * any other fd (a pipe to a step that's done), it ends that step only.
   */
  private async write(fd: number, text: string): Promise<void> {
    try {
      await this.os.io.write(fd, this.encoder.encode(text));
    } catch (error) {
      if (errorCode(error) !== "EPIPE" || fd > 2) throw error;
      this.running = false;
    }
  }
}

const HELP = [
  "builtins:  cd <dir>  pwd  exit [code]  help  source <file>  echo [-n]  read [name…]",
  "           test / [ ]  true  false  :  shift [n]  local NAME=v  return [n]  break  continue",
  "vars:      NAME=value  export NAME[=value]  unset NAME  env  $NAME ${NAME} \"$NAME\" '$NAME'",
  "special:   $? $# $@ $0 $1…  $(command)  $((1 + 2 * i))",
  "control:   if cmd; then …; elif cmd; then …; else …; fi",
  "           while cmd; do …; done   until cmd; do …; done   for x in a b *.js; do …; done",
  "           name() { …; }   { …; }   ! cmd",
  "files:     ls  cat  touch  mkdir [-p]  rmdir  rm [-r]  cp  mv   (globs: * ? [ab])",
  "text:      head  tail  wc  grep  sort  uniq  tee",
  "find:      tree  find [-name glob]  stat",
  "procs:     ps   kill [-SIGNAL] pid|-pgid   sleep N",
  "jobs:      cmd &   jobs   fg [%n]   bg [%n]   Ctrl-Z stops, Ctrl-C interrupts",
  "terminal:  stty [size | -a | [-]echo | [-]icanon | [-]isig]",
  "misc:      date  whoami  uname  open <url>  bundle <app.js>",
  "programs:  anything on $PATH (export PATH=/home/bin:$PATH)",
  "scripts:   #!/ProgramFiles/sh, #!/ProgramFiles/node (JS), #!/ProgramFiles/jsapp (GUI)",
  "startup:   $HOME/.profile is sourced when sh starts",
  "redirect:  cmd > file  >> file  < file  2> file  2>&1",
  "pipeline:  cmd | cmd | cmd   (one builtin/loop may join in)",
  "chain:     cmd && cmd (if ok)   cmd || cmd (if not)   cmd ; cmd (always)",
  "",
].join("\n");

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const shell = new Shell(os);
  os.process.exit(await shell.run(args[0], args.slice(1)));
}
