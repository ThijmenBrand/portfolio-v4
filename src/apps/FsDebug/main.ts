import type { DirEntry } from "../../kernel/fs/types";
import type { KernelInterface } from "../../kernel/syscalls/api";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

import fsDebugHTML from "./fs-debug.html?raw";
import rowHTML from "./row.html?raw";
import "./fs-debug.css";

const MAX_PREVIEW_BYTES = 64 * 1024;

/**
 * Duck-typed on purpose. The CODE STRING is the contract, not the class —
 * `instanceof KernelError` will not survive the iframe boundary once errors
 * cross a MessagePort and get rebuilt from a plain object.
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

// The app cannot import kernel/fs/path.ts — that is kernel-internal, and would
// be unreachable once apps run in iframes. Same reason the desktop has its own
// drag code.
function joinPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function formatSize(entry: DirEntry): string {
  if (entry.kind === "directory") return `${entry.size} items`;
  if (entry.size < 1024) return `${entry.size} B`;
  return `${(entry.size / 1024).toFixed(1)} KB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function main(os: KernelInterface): void {
  const app = new FsDebug(os);
  os.process.onSignal("SIGTERM", () => {
    app.destroy();
    os.process.exit(0);
  });
}

class FsDebug {
  private readonly os: KernelInterface;
  private readonly close: () => void;

  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly pathInput: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly editor: HTMLTextAreaElement;
  private readonly selectionLabel: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;

  private cwd = "/";
  private entries: DirEntry[] = [];
  private selected: DirEntry | null = null;
  private disposed = false;

  constructor(os: KernelInterface) {
    this.os = os;

    const handle = os.windows.create({
      title: "Files (debug)",
      width: 780,
      height: 480,
      minWidth: 520,
      minHeight: 320,
    });
    this.close = () => handle.close();
    handle.onCloseRequest(() => os.process.exit(0));

    this.root = htmlStringToTemplate(fsDebugHTML);
    handle.body.appendChild(this.root);

    this.list = this.field("list");
    this.pathInput = this.field<HTMLInputElement>("path");
    this.nameInput = this.field<HTMLInputElement>("name");
    this.editor = this.field<HTMLTextAreaElement>("editor");
    this.selectionLabel = this.field("selection");
    this.statusBar = this.field("status");
    this.saveButton = this.field<HTMLButtonElement>("save");
    this.deleteButton = this.field<HTMLButtonElement>("delete");

    this.bind();
    void this.navigate("/");
  }

  public destroy(): void {
    this.disposed = true;
    this.close();
  }

  private field<T extends HTMLElement = HTMLElement>(name: string): T {
    return selectElementFromTemplate<T>(this.root, `[data-field="${name}"]`);
  }

  private bind(): void {
    this.field("up").addEventListener("click", () =>
      this.navigate(parentPath(this.cwd)),
    );
    this.field("go").addEventListener("click", () =>
      this.navigate(this.pathInput.value.trim()),
    );
    this.pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter")
        void this.navigate(this.pathInput.value.trim());
    });

    this.field("new-dir").addEventListener("click", () =>
      this.createEntry("directory"),
    );
    this.field("new-file").addEventListener("click", () =>
      this.createEntry("file"),
    );
    this.deleteButton.addEventListener("click", () => this.removeSelected());
    this.saveButton.addEventListener("click", () => this.saveSelected());
    this.field("seed").addEventListener("click", () => this.seed());

    this.editor.addEventListener("input", () => {
      this.saveButton.disabled = this.selected?.kind !== "file";
    });
  }

  // ------------------------------------------------------------- operations

  /**
   * Every syscall goes through here so the status bar always shows the errno.
   * That is the entire point of this app: seeing ENOENT / EEXIST / EISDIR /
   * EROFS / EBUSY come back from the kernel rather than a generic failure.
   */
  private async run<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await operation();
      if (!this.disposed) this.setStatus(`${label} → ok`, false);
      return { ok: true, value };
    } catch (error) {
      const code = errorCode(error) ?? "EUNKNOWN";
      if (!this.disposed) {
        this.setStatus(`${label} → ${code}: ${errorMessage(error)}`, true);
      }
      return { ok: false };
    }
  }

  private async navigate(path: string): Promise<void> {
    const target = path === "" ? "/" : path;

    const listed = await this.run(`readdir ${target}`, () =>
      this.os.fs.readdir(target),
    );
    if (!listed.ok || this.disposed) return;

    const info = await this.os.fs.stat(target).catch(() => undefined);

    this.cwd = target;
    this.pathInput.value = target;
    this.entries = [...listed.value].sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name),
    );

    this.select(null);
    this.render();

    if (info?.readonly)
      this.setStatus(`${target} → ok (read-only mount)`, false);
  }

  private async createEntry(kind: "file" | "directory"): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name) {
      this.setStatus("enter a name first", true);
      return;
    }

    const path = joinPath(this.cwd, name);
    const result =
      kind === "directory"
        ? await this.run(`mkdir ${path}`, () => this.os.fs.mkdir(path))
        : await this.run(`writeFile ${path}`, () =>
            this.os.fs.writeTextFile(path, ""),
          );

    if (!result.ok) return;
    this.nameInput.value = "";
    await this.refresh();
  }

  private async removeSelected(): Promise<void> {
    if (!this.selected) return;

    const path = joinPath(this.cwd, this.selected.name);
    const result = await this.run(`unlink ${path}`, () =>
      this.os.fs.unlink(path),
    );
    if (!result.ok) return;

    this.select(null);
    await this.refresh();
  }

  private async saveSelected(): Promise<void> {
    if (this.selected?.kind !== "file") return;

    const path = joinPath(this.cwd, this.selected.name);
    const result = await this.run(`writeFile ${path}`, () =>
      this.os.fs.writeTextFile(path, this.editor.value),
    );
    if (!result.ok) return;

    this.saveButton.disabled = true;
    await this.refresh();
  }

  private async seed(): Promise<void> {
    await this.run("seed", async () => {
      await this.os.fs.writeTextFile(
        joinPath(this.cwd, "readme.txt"),
        "the vfs works.\n\ntry editing this and hitting Save.\n",
      );
      await this.os.fs.writeTextFile(
        joinPath(this.cwd, "notes.md"),
        "# notes\n\n- mount table\n- node handles\n- kernel owns the walk\n",
      );
      await this.os.fs.mkdir(joinPath(this.cwd, "subdir"));
    });
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const previous = this.selected?.name;
    await this.navigate(this.cwd);
    if (!previous) return;

    const again = this.entries.find((entry) => entry.name === previous);
    if (again) void this.open(again);
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    this.list.replaceChildren();

    if (this.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "fsd-empty";
      empty.textContent = "(empty directory)";
      this.list.appendChild(empty);
      return;
    }

    for (const entry of this.entries) {
      const row = htmlStringToTemplate(rowHTML);

      selectElementFromTemplate(row, '[data-field="icon"]').textContent =
        entry.kind === "directory" ? "▸" : "·";
      selectElementFromTemplate(row, '[data-field="name"]').textContent =
        entry.name;
      selectElementFromTemplate(row, '[data-field="size"]').textContent =
        formatSize(entry);
      selectElementFromTemplate(row, '[data-field="time"]').textContent =
        formatTime(entry.modifiedAt);

      row.addEventListener("click", () => void this.open(entry));
      row.addEventListener("dblclick", () => {
        if (entry.kind === "directory") {
          void this.navigate(joinPath(this.cwd, entry.name));
        }
      });

      if (this.selected?.name === entry.name) row.classList.add("is-selected");
      this.list.appendChild(row);
    }
  }

  private async open(entry: DirEntry): Promise<void> {
    this.select(entry);

    const path = joinPath(this.cwd, entry.name);
    this.selectionLabel.textContent = `${path} — ${entry.kind}, ${entry.size} bytes`;

    if (entry.kind === "directory") {
      this.editor.value = "";
      this.editor.disabled = true;
      this.saveButton.disabled = true;
      return;
    }

    if (entry.size > MAX_PREVIEW_BYTES) {
      this.editor.value = `(${entry.size} bytes — too large to preview)`;
      this.editor.disabled = true;
      this.saveButton.disabled = true;
      return;
    }

    const result = await this.run(`readFile ${path}`, () =>
      this.os.fs.readTextFile(path),
    );
    if (!result.ok || this.disposed) return;

    this.editor.value = result.value;
    this.editor.disabled = false;
    this.saveButton.disabled = true;
  }

  private select(entry: DirEntry | null): void {
    this.selected = entry;
    this.deleteButton.disabled = entry === null;

    if (!entry) {
      this.selectionLabel.textContent = "No selection";
      this.editor.value = "";
      this.editor.disabled = true;
      this.saveButton.disabled = true;
    }

    for (const row of this.list.children) {
      const name = row.querySelector('[data-field="name"]')?.textContent;
      row.classList.toggle(
        "is-selected",
        entry !== null && name === entry.name,
      );
    }
  }

  private setStatus(text: string, isError: boolean): void {
    this.statusBar.textContent = text;
    this.statusBar.classList.toggle("is-error", isError);
  }
}
