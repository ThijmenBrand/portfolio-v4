// admin — the owner's private app, and the place both private paths are
// proved end to end:
//   api.fetch -> server -> session check        (/api/private/ping)
//   os.fs     -> VFS -> remotefs -> server      (/mnt/cloud, synced notes)
// The notes below are ordinary file reads and writes. Nothing here knows the
// bytes live on a server; that is the point of putting it behind the VFS.
import type { AppInterface } from "../../kernel/syscalls/api";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";
import "./admin.css";

const DIR = "/mnt/cloud/admin";
const NOTES = `${DIR}/notes.md`;
const SAVE_AFTER = 800; // ms of quiet before writing

const code = (error: unknown): string =>
  (error as { code?: string }).code ?? "ERROR";

/** What each failure means to someone looking at the window. */
function explain(error: unknown): string {
  switch (code(error)) {
    case "EACCES":
      return "Signed out — log in as the owner to use this.";
    case "EIO":
      return "Can't reach the server. Your last saved copy is safe.";
    case "ENOSPC":
      return "No room left in cloud storage.";
    case "EFBIG":
      return "These notes are too large to store.";
    default:
      return `Couldn't save (${code(error)}).`;
  }
}

export async function main(os: AppInterface): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Admin" });
  void handle.onCloseRequest(() => void os.process.exit(0));

  document.body.innerHTML = `
    <main class="admin">
      <p class="admin-backend" data-field="backend">Checking the backend…</p>
      <label class="admin-label" for="notes">
        Notes <span class="admin-path">${NOTES}</span>
      </label>
      <textarea id="notes" class="admin-notes" data-field="notes"
        placeholder="Anything here follows you to your other browsers."
        spellcheck="false" disabled></textarea>
      <p class="admin-status" data-field="status" role="status"></p>
    </main>`;

  const field = <T extends HTMLElement>(name: string) =>
    document.querySelector<T>(`[data-field="${name}"]`)!;
  const backend = field("backend");
  const notes = field<HTMLTextAreaElement>("notes");
  const status = field("status");

  const say = (text: string, kind: "" | "busy" | "bad" = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  void checkBackend(os, backend);

  // What was on the server when this window last agreed with it. A different
  // stamp at save time means another browser got in since.
  let seenAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stamp = async (): Promise<number> =>
    os.fs.stat(NOTES).then((s) => s.modifiedAt, () => 0);

  try {
    await os.fs.mkdir(DIR).catch((error: unknown) => {
      if (code(error) !== "EEXIST") throw error;
    });
    notes.value = await os.fs.readTextFile(NOTES).catch((error: unknown) => {
      if (code(error) === "ENOENT") return ""; // first run
      throw error;
    });
    seenAt = await stamp();
    notes.disabled = false;
    say("Up to date.");
  } catch (error) {
    say(explain(error), "bad");
    return;
  }

  const save = async () => {
    say("Saving…", "busy");
    try {
      // The filesystem can't tie a read to a later write, so the check lives
      // here: last writer wins, but at least say so rather than pretend.
      const now = await stamp();
      if (seenAt && now && now !== seenAt) {
        say("Changed in another browser. Reopen to see it, or keep typing to overwrite.", "bad");
        seenAt = now; // one warning, then this window's copy is the truth
        return;
      }
      await os.fs.writeTextFile(NOTES, notes.value);
      seenAt = await stamp();
      say(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
    } catch (error) {
      say(explain(error), "bad");
    }
  };

  notes.addEventListener("input", () => {
    say("Unsaved changes…", "busy");
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_AFTER);
  });
  // Don't lose the last keystrokes to a close.
  notes.addEventListener("blur", () => {
    if (status.dataset.kind === "busy") {
      clearTimeout(timer);
      void save();
    }
  });
}

async function checkBackend(os: AppInterface, into: HTMLElement): Promise<void> {
  try {
    const response = await os.api.fetch("/api/private/ping");
    into.textContent =
      response.status === 200
        ? `Backend OK, signed in as ${(JSON.parse(response.body) as { user: string }).user}.`
        : `Backend says ${response.status}: not signed in.`;
  } catch (error) {
    into.textContent = `Backend unreachable: ${code(error)}`;
  }
}
