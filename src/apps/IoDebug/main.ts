import type { FdInfo, OpenFlags, Whence } from "../../kernel/fs/openfile";
import type { KernelInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import fdRowHTML from "./fd-row.html?raw";
import ioDebugHTML from "./io-debug.html?raw";
import "./io-debug.css";
import "../../ui/theme.css";

const CHILD_PATH = "/ProgramFiles/io-child";
const CHILD_FD = 3;
const MAX_LOG_LINES = 500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Duck-typed on purpose. The CODE STRING is the contract, not the class —
 * `instanceof KernelError` will not survive the iframe boundary once errors
 * cross a MessagePort and get rebuilt from a plain object. Same reason
 * FsDebug carries its own copy of this.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code: unknown }).code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Byte-level, deliberately. Reads return bytes and /proc/<pid>/cmdline is
 * NUL-separated — decoding as UTF-8 would render those as nothing at all and
 * make a correct read look like an empty one.
 */
function printable(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "␀";
    else if (byte === 10) out += "⏎";
    else if (byte < 32 || byte === 127)
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

function unescape(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\0/g, "\0");
}

function parseFlags(spec: string): OpenFlags {
  const flags: OpenFlags = {};
  for (const ch of spec) {
    if (ch === "r") flags.read = true;
    else if (ch === "w") flags.write = true;
    else if (ch === "c") flags.create = true;
    else if (ch === "t") flags.truncate = true;
    else if (ch === "a") flags.append = true;
    else if (ch === "+") continue;
    else throw new Error(`unknown flag "${ch}" (use r w c t a)`);
  }
  if (!flags.read && !flags.write) {
    throw new Error(`no access mode in "${spec}" — needs r and/or w`);
  }
  return flags;
}

function formatFlags(flags: OpenFlags): string {
  const mode =
    flags.read && flags.write
      ? "rw"
      : flags.write
        ? "w"
        : flags.read
          ? "r"
          : "-";
  const extra = [
    flags.create ? "c" : "",
    flags.truncate ? "t" : "",
    flags.append ? "a" : "",
  ].join("");
  return extra ? `${mode}+${extra}` : mode;
}

function num(raw: string | undefined, label: string): number {
  if (raw === undefined) throw new Error(`missing ${label}`);
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${label} is not a number: ${raw}`);
  return value;
}

function whence(raw: string | undefined): Whence {
  if (raw === undefined || raw === "set") return "set";
  if (raw === "cur" || raw === "end") return raw;
  throw new Error(`whence must be set|cur|end, got "${raw}"`);
}

// ---------------------------------------------------------------- test suite

interface TestCase {
  name: string;
  run(): Promise<void>;
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function expectCode(
  code: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const actual = errorCode(error);
    expect(
      actual === code,
      `expected ${code}, got ${actual ?? "a plain error"}`,
    );
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/**
 * Cases use /proc/version rather than /proc/uptime: uptime regenerates on every
 * read(), so two sequential reads differ even when the offset never advanced.
 * A static file can only pass if the offset really moved.
 *
 * Anything touching SEEK_END uses /tmp — procfs reports size 0, so seeking to
 * "end" there lands at 0 and proves nothing.
 */
function buildCases(os: KernelInterface): TestCase[] {
  return [
    {
      name: "offset advances across reads",
      run: async () => {
        const fd = await os.io.open("/proc/version", { read: true });
        try {
          const first = decode(await os.io.read(fd, 8));
          const second = decode(await os.io.read(fd, 8));
          expect(
            first === "ProcFS V",
            `first read was ${JSON.stringify(first)}`,
          );
          expect(
            second === "ersion 1",
            `second read was ${JSON.stringify(second)}`,
          );
        } finally {
          await os.io.close(fd);
        }
      },
    },
    {
      name: "dup shares the offset",
      run: async () => {
        const fd = await os.io.open("/proc/version", { read: true });
        let copy = -1;
        try {
          await os.io.read(fd, 8);
          copy = os.io.dup(fd);
          const text = decode(await os.io.read(copy, 8));
          expect(
            text === "ersion 1",
            `dup started at offset 0 — the description was copied, not shared (got ${JSON.stringify(text)})`,
          );
        } finally {
          await os.io.close(fd);
          if (copy >= 0) await os.io.close(copy).catch(() => {});
        }
      },
    },
    {
      name: "closing one dup keeps the other open",
      run: async () => {
        const fd = await os.io.open("/proc/version", { read: true });
        const copy = os.io.dup(fd);
        await os.io.close(fd);
        try {
          const text = decode(await os.io.read(copy, 8));
          expect(
            text === "ProcFS V",
            `read after partial close gave ${JSON.stringify(text)}`,
          );
        } finally {
          await os.io.close(copy);
        }
      },
    },
    {
      name: "read after close is EBADF",
      run: async () => {
        const fd = await os.io.open("/proc/version", { read: true });
        await os.io.close(fd);
        await expectCode("EBADF", () => os.io.read(fd, 4));
      },
    },
    {
      name: "read on a write-only fd is EBADF",
      run: async () => {
        const fd = await os.io.open("/tmp/io-writeonly", {
          write: true,
          create: true,
          truncate: true,
        });
        try {
          await expectCode("EBADF", () => os.io.read(fd, 4));
        } finally {
          await os.io.close(fd);
        }
      },
    },
    {
      name: "opening a procfs file for write is EROFS",
      run: () =>
        expectCode("EROFS", () => os.io.open("/proc/version", { write: true })),
    },
    {
      name: "opening a directory is EISDIR",
      run: () =>
        expectCode("EISDIR", () => os.io.open("/proc", { read: true })),
    },
    {
      name: "write, seek 0, read round-trips",
      run: async () => {
        const fd = await os.io.open("/tmp/io-round", {
          read: true,
          write: true,
          create: true,
          truncate: true,
        });
        try {
          await os.io.write(fd, encode("round-trip"));
          await os.io.seek(fd, 0, "set");
          const text = decode(await os.io.read(fd, 64));
          expect(text === "round-trip", `got ${JSON.stringify(text)}`);
        } finally {
          await os.io.close(fd);
        }
      },
    },
    {
      name: "seek to end then read returns zero bytes",
      run: async () => {
        const fd = await os.io.open("/tmp/io-seek", {
          read: true,
          write: true,
          create: true,
          truncate: true,
        });
        try {
          await os.io.write(fd, encode("hello"));
          await os.io.seek(fd, 0, "end");
          const bytes = await os.io.read(fd, 8);
          expect(bytes.length === 0, `expected EOF, got ${bytes.length} bytes`);
        } finally {
          await os.io.close(fd);
        }
      },
    },
    {
      name: "two appending descriptions do not overwrite each other",
      run: async () => {
        const path = "/tmp/io-append";
        await os.fs.writeTextFile(path, "");
        const a = await os.io.open(path, { write: true, append: true });
        const b = await os.io.open(path, { write: true, append: true });
        try {
          await os.io.write(a, encode("x"));
          await os.io.write(b, encode("y"));
          const text = await os.fs.readTextFile(path);
          expect(
            text === "xy",
            `got ${JSON.stringify(text)} — append must recompute the position per write`,
          );
        } finally {
          await os.io.close(a);
          await os.io.close(b);
        }
      },
    },
    {
      name: "the table runs out of descriptors with EMFILE",
      run: async () => {
        const fds: number[] = [];
        try {
          let code: string | undefined;
          // Loop until it fails rather than counting to 256 — the console may
          // already be holding fds, and a hardcoded count would break then.
          for (let i = 0; i <= 300; i += 1) {
            try {
              fds.push(await os.io.open("/proc/version", { read: true }));
            } catch (error) {
              code = errorCode(error);
              break;
            }
          }
          expect(
            code === "EMFILE",
            `expected EMFILE, got ${code ?? "no error after 300 opens"}`,
          );
        } finally {
          for (const fd of fds) await os.io.close(fd).catch(() => {});
        }
      },
    },
    {
      name: "a spawned child shares the parent's description",
      run: async () => {
        const path = "/tmp/io-inherit";
        const fd = await os.io.open(path, {
          write: true,
          create: true,
          truncate: true,
        });
        try {
          os.io.dup(fd, CHILD_FD);
          const pid = os.process.spawn(CHILD_PATH, ["a"]);
          await os.process.wait(pid);

          // Child wrote "a" at offset 0, advancing the SHARED offset to 1.
          await os.io.write(fd, encode("b"));

          const text = await os.fs.readTextFile(path);
          expect(
            text === "ab",
            `got ${JSON.stringify(text)} — "b" alone means inheritFrom copied the description instead of sharing it`,
          );
        } finally {
          await os.io.close(fd).catch(() => {});
          await os.io.close(CHILD_FD).catch(() => {});
        }
      },
    },
  ];
}

// ----------------------------------------------------------------------- app

export function main(os: KernelInterface): void {
  const app = new IoDebug(os);
  os.process.onSignal("SIGTERM", () => {
    app.destroy();
    os.process.exit(0);
  });
}

type LogKind = "in" | "out" | "err" | "info" | "ok";

class IoDebug {
  private readonly os: KernelInterface;
  private readonly close: () => void;

  private readonly root: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly fdList: HTMLElement;
  private readonly fdCount: HTMLElement;
  private readonly statusBar: HTMLElement;

  private readonly history: string[] = [];
  private historyIndex = 0;
  private disposed = false;

  private readonly commands: Record<
    string,
    (args: string[], rest: string) => Promise<string>
  >;

  constructor(os: KernelInterface) {
    this.os = os;

    const handle = os.windows.create({
      title: "io (debug)",
      width: 860,
      height: 520,
      minWidth: 600,
      minHeight: 340,
    });
    this.close = () => handle.close();
    handle.onCloseRequest(() => os.process.exit(0));

    this.root = htmlStringToTemplate(ioDebugHTML);
    handle.body.appendChild(this.root);

    this.log = this.field("log");
    this.input = this.field<HTMLInputElement>("input");
    this.fdList = this.field("fds");
    this.fdCount = this.field("count");
    this.statusBar = this.field("status");

    this.commands = this.buildCommands();

    this.bind();
    this.append(
      "os.io console — `help` for commands, `test` for the suite",
      "info",
    );
    this.refreshFds();
  }

  public destroy(): void {
    this.disposed = true;
    this.close();
  }

  private field<T extends HTMLElement = HTMLElement>(name: string): T {
    return selectElementFromTemplate<T>(this.root, `[data-field="${name}"]`);
  }

  private bind(): void {
    this.field("test").addEventListener("click", () => void this.runTests());
    this.field("clear").addEventListener("click", () => {
      this.log.replaceChildren();
    });

    this.root.addEventListener("mouseup", () => {
      if (window.getSelection()?.isCollapsed !== false) this.input.focus();
    });

    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const line = this.input.value;
        this.input.value = "";
        void this.submit(line);
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        this.recall(event.key === "ArrowUp" ? -1 : 1);
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

  // ------------------------------------------------------------- commands

  private buildCommands(): Record<
    string,
    (args: string[], rest: string) => Promise<string>
  > {
    const os = this.os;

    return {
      help: async () =>
        [
          "open  <path> [rwcta]      open a file, prints the fd",
          "read  <fd> [bytes=64]     read at the current offset",
          "write <fd> <text>         write at the current offset (\\n \\t \\0 work)",
          "seek  <fd> <off> [set|cur|end]",
          "dup   <fd> [to]           duplicate, sharing the description",
          "close <fd>",
          "fstat <fd>",
          "cat   <path>              open, read until EOF, close",
          "fds                       dump the table (also shown on the right)",
          "test                      run the self-test suite",
          "clear",
        ].join("\n"),

      open: async (args) => {
        const path = args[0];
        if (!path) throw new Error("usage: open <path> [rwcta]");
        const fd = await os.io.open(path, parseFlags(args[1] ?? "r"));
        return `fd ${fd}`;
      },

      read: async (args) => {
        const fd = num(args[0], "fd");
        const bytes = await os.io.read(
          fd,
          args[1] === undefined ? 64 : num(args[1], "length"),
        );
        return bytes.length === 0
          ? "(0 bytes — EOF)"
          : `${bytes.length} bytes: ${printable(bytes)}`;
      },

      write: async (args, rest) => {
        const fd = num(args[0], "fd");
        const text = unescape(rest.slice(args[0]!.length).trimStart());
        if (text === "") throw new Error("usage: write <fd> <text>");
        return `${await os.io.write(fd, encode(text))} bytes written`;
      },

      seek: async (args) => {
        const fd = num(args[0], "fd");
        const offset = num(args[1], "offset");
        return `offset ${await os.io.seek(fd, offset, whence(args[2]))}`;
      },

      dup: async (args) => {
        const fd = num(args[0], "fd");
        const to =
          args[1] === undefined ? undefined : num(args[1], "target fd");
        return `fd ${os.io.dup(fd, to)}`;
      },

      close: async (args) => {
        await os.io.close(num(args[0], "fd"));
        return "closed";
      },

      fstat: async (args) => {
        const info = await os.io.fstat(num(args[0], "fd"));
        return `${info.kind} ${info.size} bytes`;
      },

      // The read-until-zero loop, by hand. A short read is not EOF — only a
      // zero-length one is, which is exactly what procfs (size 0) proves.
      cat: async (args) => {
        const path = args[0];
        if (!path) throw new Error("usage: cat <path>");

        const fd = await os.io.open(path, { read: true });
        try {
          const chunks: Uint8Array[] = [];
          let reads = 0;
          for (;;) {
            const chunk = await os.io.read(fd, 4096);
            if (chunk.length === 0) break;
            chunks.push(chunk);
            reads += 1;
            if (reads > 4096) throw new Error("read loop did not terminate");
          }
          const total = chunks.reduce((sum, c) => sum + c.length, 0);
          const merged = new Uint8Array(total);
          let at = 0;
          for (const chunk of chunks) {
            merged.set(chunk, at);
            at += chunk.length;
          }
          return `${total} bytes in ${reads} read(s):\n${printable(merged)}`;
        } finally {
          await os.io.close(fd);
        }
      },

      fds: async () => {
        const list = os.io.listFds();
        if (list.length === 0) return "(no open descriptors)";
        return list
          .map(
            (info) =>
              `${info.fd}  ${formatFlags(info.flags)}  off=${info.offset}  refs=${info.refs}  ${info.description}`,
          )
          .join("\n");
      },

      test: async () => {
        await this.runTests();
        return "";
      },

      clear: async () => {
        this.log.replaceChildren();
        return "";
      },
    };
  }

  private async submit(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === "") return;

    this.history.push(trimmed);
    this.historyIndex = this.history.length;
    this.append(`$ ${trimmed}`, "in");

    const parts = trimmed.split(/\s+/);
    const name = parts[0]!;
    const args = parts.slice(1);
    const rest = trimmed.slice(name.length).trimStart();

    const command = this.commands[name];
    if (!command) {
      this.append(`unknown command: ${name} (try \`help\`)`, "err");
      return;
    }

    try {
      const output = await command(args, rest);
      if (output !== "" && !this.disposed) this.append(output, "out");
      this.setStatus(`${name} → ok`, false);
    } catch (error) {
      const code = errorCode(error);
      // Kernel failures carry an errno; argument mistakes are plain Errors.
      this.append(
        code ? `${code}: ${errorMessage(error)}` : errorMessage(error),
        "err",
      );
      this.setStatus(`${name} → ${code ?? "error"}`, true);
    } finally {
      this.refreshFds();
    }
  }

  private async runTests(): Promise<void> {
    this.append("running tests…", "info");

    let passed = 0;
    let failed = 0;

    for (const testCase of buildCases(this.os)) {
      if (this.disposed) return;
      try {
        await testCase.run();
        this.append(`  ✓ ${testCase.name}`, "ok");
        passed += 1;
      } catch (error) {
        const code = errorCode(error);
        this.append(
          `  ✗ ${testCase.name} — ${code ? `${code}: ` : ""}${errorMessage(error)}`,
          "err",
        );
        failed += 1;
      }
      this.refreshFds();
    }

    this.append(
      `${passed} passed, ${failed} failed`,
      failed === 0 ? "ok" : "err",
    );
    this.setStatus(`tests → ${passed} passed, ${failed} failed`, failed !== 0);
  }

  // --------------------------------------------------------------- render

  private refreshFds(): void {
    if (this.disposed) return;

    let list: FdInfo[];
    try {
      list = this.os.io.listFds();
    } catch {
      return;
    }

    this.fdCount.textContent = String(list.length);
    this.fdList.replaceChildren();

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "iod-empty";
      empty.textContent = "(none open)";
      this.fdList.appendChild(empty);
      return;
    }

    for (const info of list.sort((a, b) => a.fd - b.fd)) {
      const row = htmlStringToTemplate(fdRowHTML);

      selectElementFromTemplate(row, '[data-field="fd"]').textContent = String(
        info.fd,
      );
      selectElementFromTemplate(row, '[data-field="description"]').textContent =
        info.description;
      selectElementFromTemplate(row, '[data-field="flags"]').textContent =
        formatFlags(info.flags);
      selectElementFromTemplate(row, '[data-field="offset"]').textContent =
        info.seekable ? String(info.offset) : "—";

      const refs = selectElementFromTemplate(row, '[data-field="refs"]');
      refs.textContent = `×${info.refs}`;
      // A shared description is the interesting state — dup and inheritance
      // are the only things that produce it.
      if (info.refs > 1) refs.classList.add("is-shared");

      this.fdList.appendChild(row);
    }
  }

  private append(text: string, kind: LogKind): void {
    const line = document.createElement("div");
    line.className = `iod-line is-${kind}`;
    line.textContent = text;
    this.log.appendChild(line);

    while (this.log.childElementCount > MAX_LOG_LINES) {
      this.log.firstElementChild?.remove();
    }

    this.log.scrollTop = this.log.scrollHeight;
  }

  private setStatus(text: string, isError: boolean): void {
    this.statusBar.textContent = text;
    this.statusBar.classList.toggle("is-error", isError);
  }
}
