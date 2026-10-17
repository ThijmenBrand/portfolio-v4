import { marked } from "marked";
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode } from "../../bin/lib/input";
import { extOf } from "../../utils/filetypes";
import { followAccent } from "../../utils/settings";
import "../../ui/theme.css";
import "./reader.css";

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

marked.use({
  renderer: {
    html: ({ text }) => escape(text),
    link({ href, tokens }) {
      if (/^(https?:|mailto:|#)/i.test(href)) return false; // default renderer
      return this.parser.parseInline(tokens);
    },
  },
});

export async function main(os: AppInterface, args: string[] = []): Promise<void> {
  await followAccent(os);
  const handle = await os.windows.create({ title: "Reader" });
  void handle.onCloseRequest(() => void os.process.exit(0));

  let path: string | undefined = args[0];
  if (!path) {
    try {
      path = (await os.dialog.open({ kind: "file", title: "Open Document" })) ?? undefined;
    } catch (error) {
      return say(`Couldn't open the file picker (${errorCode(error)}).`);
    }
    if (!path) return void os.process.exit(0);
  }

  const name = path.slice(path.lastIndexOf("/") + 1);
  void handle.setTitle(name);

  try {
    const ext = extOf(path);
    if (ext === "md") showMarkdown(await os.fs.readTextFile(path));
    else if (ext === "pdf") {
      const file = path;
      say(`Opening ${name}…`); // a big PDF takes a moment to parse
      await (await import("./pdf")).showPdf(await os.fs.readFile(file), name, {
        write: (bytes) => os.fs.writeFile(file, bytes),
        setTitle: (title) => void handle.setTitle(title),
      });
    }
    else say(`${name} isn't a PDF or Markdown file.`);
  } catch (error) {
    say(`Couldn't open ${name} (${errorCode(error)}).`);
  }
}

function showMarkdown(text: string): void {
  const article = document.createElement("article");
  article.className = "doc";
  article.innerHTML = marked.parse(text, { async: false });
  for (const a of article.querySelectorAll("a[href^='http']")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  document.body.replaceChildren(article);
}

function say(message: string): void {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  document.body.replaceChildren(p);
}
