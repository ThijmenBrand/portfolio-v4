import pickerHTML from "./picker.html?raw";
import "./picker.css";
import type { DirEntry } from "../fs/types";
import { dirname } from "../fs/path";
import { htmlStringToTemplate, selectElementFromTemplate } from "../../utils/html";
import { PLACES } from "../../utils/places";
import { crumbs, visibleEntries, type DialogOptions } from "./list";

const FOLDER_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>';
const FILE_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3"/></svg>';

// ponytail: search walks the tree breadth-first and stops here; an index if trees get big.
const SEARCH_MAX_DIRS = 400;
const SEARCH_MAX_HITS = 200;

export interface Picker {
  result: Promise<string | null>;
  cancel(): void;
}

/** What the picker does with the caller's credentials. */
export interface PickerFs {
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
}

type Row = { el: HTMLElement; path: string; isDir: boolean };

const join = (dir: string, name: string) => `${dir === "/" ? "" : dir}/${name}`;
const inside = (path: string, dir: string) =>
  path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

/**
 * The file/folder picker behind `dialog.open`. Kernel-rendered, so an app
 * only ever learns the path the user chose. `fs` must carry the caller's
 * credentials; `mount` places the sheet and returns its remover.
 */
export function showPicker(
  options: Required<Pick<DialogOptions, "kind">> & { title?: string },
  start: string,
  home: string,
  fs: PickerFs,
  mount: (picker: HTMLElement) => () => void,
): Picker {
  const root = htmlStringToTemplate(pickerHTML);
  const q = <T extends HTMLElement>(s: string) =>
    selectElementFromTemplate<T>(root, s);
  const crumbsEl = q(".picker-crumbs");
  const placesEl = q(".picker-places");
  const list = q(".picker-list");
  const search = q<HTMLInputElement>(".picker-search");
  const openBtn = q<HTMLButtonElement>(".picker-open");
  q(".picker-title").textContent =
    options.title ??
    (options.kind === "directory" ? "Open Folder" : "Open File");

  let dir = start;
  let rows: Row[] = [];
  let selected = -1;
  let gen = 0; // bumps on every navigation/search; stale reads bail out

  let settle!: (value: string | null) => void;
  const result = new Promise<string | null>((r) => (settle = r));
  let unmount = (): void => {};
  let done = false;
  const finish = (value: string | null): void => {
    if (done) return;
    done = true;
    unmount();
    settle(value);
  };

  const select = (index: number): void => {
    selected = index;
    rows.forEach((row, i) => row.el.classList.toggle("selected", i === index));
    rows[index]?.el.scrollIntoView({ block: "nearest" });
    openBtn.disabled = options.kind === "file" && !rows[index];
  };

  /** Enter a folder, or (picking a file) choose the file. */
  const activate = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    if (row.isDir) void go(row.path);
    else finish(row.path);
  };

  const confirm = (): void => {
    const row = rows[selected];
    if (options.kind === "directory") finish(row?.path ?? dir);
    else if (row) activate(selected);
  };

  const places = PLACES.map((place) => {
    const path = place.path.startsWith("~") ? home + place.path.slice(1) : place.path;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.path = path.replace(/^\/\//, "/");
    btn.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${place.svg}</svg>`;
    btn.append(place.label);
    btn.addEventListener("click", () => void go(btn.dataset.path!));
    return btn;
  });
  placesEl.replaceChildren(...places);

  function show(next: Row[], empty: string): void {
    rows = next;
    rows.forEach((row, i) => {
      row.el.addEventListener("click", () => select(i));
      row.el.addEventListener("dblclick", () => activate(i));
    });
    list.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [note(empty)]));
    select(-1);
  }

  async function go(path: string, pick?: string): Promise<void> {
    const mine = ++gen;
    dir = path;
    search.value = "";
    rows = [];
    select(-1);
    crumbsEl.replaceChildren(
      ...crumbs(path).map((c) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = c.name;
        btn.addEventListener("click", () => void go(c.path));
        return btn;
      }),
    );
    // The most specific place that contains dir: ~/x lights Home, /etc Computer.
    const best = places
      .filter((p) => inside(path, p.dataset.path!))
      .sort((a, b) => b.dataset.path!.length - a.dataset.path!.length)[0];
    places.forEach((p) => p.toggleAttribute("aria-current", p === best));

    let entries: DirEntry[];
    try {
      entries = visibleEntries(await fs.readdir(path), options.kind);
    } catch (error) {
      if (mine !== gen) return;
      return list.replaceChildren(note(`Can't open this folder (${code(error)})`));
    }
    if (mine !== gen) return; // the user moved on while we were reading

    show(
      entries.map((e) => row(e.name, join(path, e.name), e.kind === "directory")),
      options.kind === "directory" ? "No subfolders." : "This folder is empty.",
    );
    if (pick) select(rows.findIndex((r) => r.path === pick));
  }

  async function find(text: string): Promise<void> {
    const mine = ++gen;
    const needle = text.trim().toLowerCase();
    if (!needle) return void go(dir);
    list.replaceChildren(note("Searching…"));

    const hits: Row[] = [];
    const queue = [dir];
    for (let seen = 0; queue.length && seen < SEARCH_MAX_DIRS && hits.length < SEARCH_MAX_HITS; seen++) {
      const at = queue.shift()!;
      let entries: DirEntry[];
      try {
        entries = visibleEntries(await fs.readdir(at), options.kind);
      } catch {
        continue; // unreadable folders just don't show up
      }
      if (mine !== gen) return;
      for (const e of entries) {
        const path = join(at, e.name);
        const isDir = e.kind === "directory";
        if (isDir) queue.push(path);
        if (e.name.toLowerCase().includes(needle))
          hits.push(row(e.name, path, isDir, at === dir ? "" : at.slice(dir.length).replace(/^\//, "")));
      }
    }
    show(hits.slice(0, SEARCH_MAX_HITS), "No matches.");
  }

  /** An inline name field at the top of the list; Enter creates the folder. */
  async function newFolder(): Promise<void> {
    if (search.value) await go(dir);
    const el = row("", "", true);
    el.el.classList.add("selected");
    const input = document.createElement("input");
    input.className = "picker-name";
    input.value = "untitled folder";
    input.setAttribute("aria-label", "Folder name");
    el.el.querySelector("span")!.replaceWith(input);
    list.querySelector(".picker-note")?.remove();
    list.prepend(el.el);
    input.focus();
    input.select();

    const close = () => el.el.remove();
    input.addEventListener("blur", close);
    input.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key === "Escape") return close();
      if (e.key !== "Enter") return;
      const name = input.value.trim();
      if (!name || name.includes("/") || name === "." || name === "..") {
        input.setCustomValidity("Not a valid folder name");
        return input.reportValidity();
      }
      const path = join(dir, name);
      try {
        await fs.mkdir(path);
      } catch (error) {
        input.setCustomValidity(
          code(error) === "EEXIST" ? "That name is taken" : `Can't create it here (${code(error)})`,
        );
        return input.reportValidity();
      }
      input.removeEventListener("blur", close);
      root.focus();
      await go(dir, path);
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
  }

  root.addEventListener("keydown", (e) => {
    // Buttons handle their own Enter/Space; the search box keeps its Backspace.
    const onButton = e.target instanceof HTMLButtonElement;
    const onInput = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
      if (onInput && search.value) void go(dir);
      else finish(null);
    } else if (e.key === "ArrowDown") select(Math.min(rows.length - 1, selected + 1));
    else if (e.key === "ArrowUp") select(Math.max(0, selected - 1));
    else if (e.key === "Enter" && !onButton)
      selected >= 0 && rows[selected].isDir ? activate(selected) : confirm();
    else if (e.key === "Backspace" && !onInput && dir !== "/") void go(dirname(dir));
    else if ((e.key === "f" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !onInput)) search.focus();
    else if (e.key.toLowerCase() === "n" && e.shiftKey && (e.metaKey || e.ctrlKey)) void newFolder();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  search.addEventListener("input", () => void find(search.value));
  q(".picker-new").addEventListener("click", () => void newFolder());
  q(".picker-cancel").addEventListener("click", () => finish(null));
  openBtn.addEventListener("click", confirm);

  unmount = mount(root);
  void go(start);
  return { result, cancel: () => finish(null) };
}

function row(name: string, path: string, isDir: boolean, where = ""): Row {
  const el = document.createElement("div");
  el.className = `picker-row${isDir ? " dir" : ""}`;
  el.setAttribute("role", "option");
  el.innerHTML = isDir ? FOLDER_SVG : FILE_SVG;
  const label = document.createElement("span");
  label.textContent = name;
  el.append(label);
  if (where) {
    const sub = document.createElement("small");
    sub.textContent = where;
    el.append(sub);
  }
  return { el, path, isDir };
}

function code(error: unknown): string {
  return (error as { code?: string }).code ?? "EIO";
}

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "picker-note";
  el.textContent = text;
  return el;
}
