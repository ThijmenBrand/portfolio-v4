// A project's notes: whatever is in its folder, so it opens as it is in
// Code, Files and the terminal too. The list is read from the folder (it is
// the list). Text notes are edited here in place, saved as you type; any
// other file -- a PDF, slides, an image -- opens in its app, and a folder in
// Files. Files are added by picking or dropping them on the list.
import { confirmDialog } from "../../utils/confirm";
import { defaultAppFor, IMAGE_TYPES, extOf } from "../../utils/filetypes";
import { loadSettings } from "../../utils/settings";
import { formatSize, freeName } from "../files/names.ts";
import { app, projectById } from "./state.ts";
import type { Project } from "./store.ts";
import { backButton, button, dayLabel, el, empty, heading, ICONS, withIcon } from "./ui.ts";

const SAVE_MS = 500;
const MAX_NOTE_BYTES = 512 * 1024;
/** Also MAX_FILE in server/fsstore.ts, what cloud storage takes. */
const MAX_UPLOAD = 20 * 1024 * 1024;

interface Entry {
  name: string;
  folder: boolean;
  size: number;
  modifiedAt: number;
}

interface Listing {
  files: Entry[];
  /** The folder couldn't be read (as opposed to being empty). */
  failed: boolean;
}

const listings = new Map<string, Listing>();
const loading = new Set<string>();

/** Text notes are edited here; everything else opens in its own app. */
const isNote = (name: string): boolean => /\.(md|markdown|txt)$/i.test(name);
const stem = (file: string): string => file.replace(/\.(md|markdown|txt)$/i, "");

/** Re-read a project's folder; draws the page again when the list changed. */
export async function loadNotes(project: Project): Promise<void> {
  if (loading.has(project.id)) return;
  loading.add(project.id);
  try {
    const dir = `${app.projects.root}/${project.folder}`;
    const entries = await app.os.fs.readdir(dir).catch((error: unknown) =>
      (error as { code?: string }).code === "ENOENT" ? [] : null,
    );
    const next: Listing = entries
      ? {
          files: entries
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => ({
              name: entry.name,
              folder: entry.kind === "directory",
              size: entry.size,
              modifiedAt: entry.modifiedAt,
            }))
            .sort(
              (a, b) =>
                Number(b.folder) - Number(a.folder) || b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name),
            ),
          failed: false,
        }
      : { files: [], failed: true };
    const before = JSON.stringify(listings.get(project.id) ?? null);
    listings.set(project.id, next);
    if (JSON.stringify(next) !== before) app.render();
  } finally {
    loading.delete(project.id);
  }
}

/** Whether an fs.changed path is in a project's folder; refreshes that list. */
export function notesChanged(path: string): void {
  const root = `${app.projects.root}/`;
  if (!path.startsWith(root)) return;
  const folder = path.slice(root.length).split("/")[0];
  const project = app.projects.data.projects.find((each) => each.folder === folder);
  if (project) void loadNotes(project);
}

async function newNote(project: Project): Promise<void> {
  try {
    const dir = await app.projects.folderOf(project);
    const taken = new Set((await app.os.fs.readdir(dir)).map((entry) => entry.name.toLowerCase()));
    let name = "Untitled.md";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Untitled ${n}.md`;
    await app.os.fs.writeTextFile(`${dir}/${name}`, "");
    await loadNotes(project);
    app.go({ view: "note", id: project.id, file: name }, "page");
  } catch {
    app.status("Couldn't make a note there.");
  }
}

/** Why a file couldn't be added, in the words the cloud's refusal means. */
function addProblem(error: unknown, name: string): string {
  switch ((error as { code?: string }).code) {
    case "EFBIG":
      return `${name} is too large for cloud storage.`;
    case "ENOSPC":
      return "There's no room left in cloud storage.";
    case "EACCES":
      return app.projects.backing === "cloud" ? "Signed out — couldn't add the file." : `Couldn't add ${name}.`;
  }
  return `Couldn't add ${name}.`;
}

/** Copy files from the computer into the project's folder, never over one that's there. */
async function addFiles(project: Project, files: File[]): Promise<void> {
  const fit = files.filter((file) => file.size <= MAX_UPLOAD);
  if (fit.length < files.length) app.status(`Skipped ${files.length - fit.length} file(s) over 20 MB.`);
  if (!fit.length) return;
  let problem: string | null = null;
  try {
    const dir = await app.projects.folderOf(project);
    const taken = new Set((await app.os.fs.readdir(dir)).map((entry) => entry.name));
    // One refused file doesn't stop the rest.
    for (const file of fit) {
      const name = freeName(file.name, taken);
      try {
        await app.os.fs.writeFile(`${dir}/${name}`, new Uint8Array(await file.arrayBuffer()));
        taken.add(name);
      } catch (error) {
        problem ??= addProblem(error, file.name);
      }
    }
  } catch (error) {
    problem = addProblem(error, fit[0]!.name);
  }
  if (problem) app.status(problem);
  await loadNotes(project);
}

/** A file that isn't a text note opens in the app it opens in from Files. */
async function openFile(project: Project, file: Entry): Promise<void> {
  const path = `${app.projects.root}/${project.folder}/${file.name}`;
  if (file.folder) {
    await app.os.process.spawn("/ProgramFiles/files", [path]).catch(() => app.status("Couldn't open Files."));
    return;
  }
  const { openWith } = await loadSettings(app.os);
  await app.os.process.spawn(defaultAppFor(path, openWith), [path]).catch(() => app.status(`Couldn't open ${file.name}.`));
}

async function removeFile(project: Project, file: Entry): Promise<void> {
  const ok = await confirmDialog(`"${file.name}" is deleted from the project's folder.`, {
    title: "Delete this file?",
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  await app.os.fs.unlink(`${app.projects.root}/${project.folder}/${file.name}`).catch(() => app.status("Couldn't delete the file."));
  await loadNotes(project);
}

const iconFor = (file: Entry): string =>
  file.folder ? ICONS.folder : IMAGE_TYPES[extOf(file.name)] ? ICONS.image : isNote(file.name) ? ICONS.note : ICONS.file;

export function notesSection(project: Project): HTMLElement {
  const node = el("section", "group-list notes");
  const listing = listings.get(project.id);
  if (!listing) void loadNotes(project);
  const path = `${app.projects.backing === "cloud" ? app.projects.root : "~/Projects"}/${project.folder}`;

  const picker = el("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    void addFiles(project, files);
  });

  const aside = el("span", "notes-actions");
  aside.append(
    button("link", withIcon(ICONS.folder, "Open folder"), async () => {
      const dir = await app.projects.folderOf(project).catch(() => null);
      if (dir) await app.os.process.spawn("/ProgramFiles/files", [dir]).catch(() => app.status("Couldn't open Files."));
    }),
    button("link", withIcon(ICONS.attach, "Add file"), () => picker.click()),
    button("link", withIcon(ICONS.plus, "New note"), () => void newNote(project)),
  );
  node.append(heading("Notes", aside), picker);
  if (listing?.failed) node.append(empty("Couldn't read the notes folder."));
  else if (listing && !listing.files.length) node.append(empty(`Notes and files in ${path} show here. Drop files here to add them.`));
  const now = new Date();
  for (const file of listing?.files ?? []) {
    const row = el("div", "row note-row");
    const note = !file.folder && isNote(file.name);
    const open = button("title", withIcon(iconFor(file), note ? stem(file.name) : file.name), () =>
      note ? app.go({ view: "note", id: project.id, file: file.name }, "page") : void openFile(project, file),
    );
    row.append(open);
    if (!file.folder && !note) row.append(el("span", "plan note-size", formatSize(file.size)));
    if (file.modifiedAt) row.append(el("span", "plan", dayLabel(new Date(file.modifiedAt), now)));
    if (!file.folder) {
      const remove = button("note-remove", ICONS.trash, () => void removeFile(project, file));
      remove.title = "Delete";
      remove.setAttribute("aria-label", `Delete ${file.name}`);
      row.append(remove);
    }
    node.append(row);
  }

  // Files dragged in from the computer land in the folder.
  const fromComputer = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes("Files");
  node.addEventListener("dragover", (event) => {
    if (!fromComputer(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
    node.classList.add("is-over");
  });
  node.addEventListener("dragleave", (event) => {
    if (!node.contains(event.relatedTarget as Node | null)) node.classList.remove("is-over");
  });
  node.addEventListener("drop", (event) => {
    node.classList.remove("is-over");
    if (!fromComputer(event)) return;
    event.preventDefault();
    void addFiles(project, [...(event.dataTransfer?.files ?? [])]);
  });
  return node;
}

// ------------------------------------------------------------ the editor --

/**
 * The note open in the editor. `ready` once its text has been read: until
 * then (and for good, when it couldn't be, `problem` saying why) the text is
 * not the file's, so nothing typed may be written over it.
 */
let editor: {
  key: string;
  text: string;
  saved: string;
  ready: boolean;
  problem?: string;
  timer?: ReturnType<typeof setTimeout>;
} | null = null;

async function flush(): Promise<void> {
  if (!editor || editor.text === editor.saved) return;
  clearTimeout(editor.timer);
  const { key, text } = editor;
  try {
    await app.os.fs.writeTextFile(key, text);
    if (editor?.key === key) editor.saved = text;
    setSaved("Saved");
  } catch {
    setSaved("Couldn't save");
    app.status("Couldn't save the note.");
  }
}

function setSaved(text: string): void {
  const node = document.querySelector<HTMLElement>(".note-saved");
  if (node) node.textContent = text;
}

/** Leaving the note: whatever is typed gets written first. */
export const leaveNote = (): Promise<void> => flush();

export function renderNote(page: HTMLElement, project: Project, file: string): void {
  const dir = `${app.projects.root}/${project.folder}`;
  const key = `${dir}/${file}`;

  const head = el("header", "page-head");
  head.append(backButton(project.code || project.name, () => app.go({ view: "project", id: project.id }, "page"), true));
  const titles = el("div", "page-titles");
  const name = el("input", "note-name");
  name.value = stem(file);
  name.setAttribute("aria-label", "Note name");
  name.maxLength = 80;
  name.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") name.blur();
  });
  name.addEventListener("change", () => void rename(project, file, name.value));
  titles.append(name, el("p", "page-sub note-saved", ""));
  const actions = el("div", "page-actions");
  actions.append(
    button("button", withIcon(ICONS.code, "Open in Code"), async () => {
      await flush();
      await app.os.process.spawn("/ProgramFiles/code", [key]).catch(() => app.status("Couldn't open Code."));
    }),
    button("button danger", withIcon(ICONS.trash, "Delete"), async () => {
      const ok = await confirmDialog(`"${stem(file)}" is deleted from the project's folder.`, {
        title: "Delete this note?",
        ok: "Delete",
        danger: true,
      });
      if (!ok) return;
      editor = null;
      await app.os.fs.unlink(key).catch(() => app.status("Couldn't delete the note."));
      await loadNotes(project);
      app.go({ view: "project", id: project.id }, "page");
    }),
  );
  head.append(titles, actions);

  const area = el("textarea", "note-text");
  area.spellcheck = true;
  area.placeholder = "Write in markdown. # A heading, - a list, **bold**.";
  area.setAttribute("aria-label", "Note");
  area.addEventListener("keydown", (event) => event.stopPropagation());
  area.addEventListener("input", () => {
    if (!editor || editor.key !== key || !editor.ready) return;
    editor.text = area.value;
    setSaved("Editing");
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => void flush(), SAVE_MS);
  });
  area.addEventListener("blur", () => void flush());

  page.replaceChildren(head, area);

  if (editor?.key === key) {
    // Drawn again while still reading, or after the read failed: stay shut.
    area.value = editor.text;
    area.disabled = !editor.ready;
    setSaved(editor.problem ?? (!editor.ready ? "" : editor.text === editor.saved ? "Saved" : "Editing"));
    return;
  }
  void flush();
  editor = { key, text: "", saved: "", ready: false };
  area.disabled = true;
  app.os.fs
    .stat(key)
    .then((stat) => {
      if (stat.size > MAX_NOTE_BYTES) throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
      return app.os.fs.readTextFile(key);
    })
    .then((text) => {
      if (editor?.key !== key) return;
      editor.text = editor.saved = text;
      editor.ready = true;
      // The page may have been drawn again meanwhile: fill the textarea on screen.
      const shown = document.querySelector<HTMLTextAreaElement>("textarea.note-text") ?? area;
      shown.value = text;
      shown.disabled = false;
      setSaved("Saved");
      shown.focus();
    })
    .catch((error: unknown) => {
      if (editor?.key !== key) return;
      editor.problem =
        (error as { code?: string }).code === "EFBIG" ? "Too large to edit here; open it in Code." : "Couldn't read this note.";
      setSaved(editor.problem);
    });
}

async function rename(project: Project, file: string, wanted: string): Promise<void> {
  const clean = wanted.replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!clean || clean === stem(file)) return;
  const ext = /\.(md|markdown|txt)$/i.exec(file)?.[0] ?? ".md";
  const next = `${clean}${ext}`;
  const dir = `${app.projects.root}/${project.folder}`;
  await flush();
  try {
    const exists = await app.os.fs.stat(`${dir}/${next}`).then(() => true, () => false);
    if (exists) {
      app.status("There's already a note with that name.");
      return;
    }
    await app.os.fs.rename(`${dir}/${file}`, `${dir}/${next}`);
    if (editor?.key === `${dir}/${file}`) editor.key = `${dir}/${next}`;
    await loadNotes(project);
    if (projectById(project.id)) app.go({ view: "note", id: project.id, file: next }, "page");
  } catch {
    app.status("Couldn't rename the note.");
  }
}

