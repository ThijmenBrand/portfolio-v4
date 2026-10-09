// resume — the portfolio's front page, as a sandboxed iframe app.
// Rendered with createElement/textContent only: no innerHTML, even for
// first-party content, so the rule stays simple everywhere.
import type { AppInterface } from "../../kernel/syscalls/api";
import { resume, type Entry } from "./content";
import photoUrl from "./photo.jpg";
import "../../ui/theme.css";
import "./resume.css";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string, ...body: HTMLElement[]): HTMLElement {
  const s = el("section", "cv-section");
  s.append(el("h2", "cv-section-title", title), ...body);
  return s;
}

function entry(item: Entry): HTMLElement {
  const e = el("article", "cv-entry");
  const head = el("header", "cv-entry-head");
  head.append(el("h3", "cv-entry-title", item.title), el("span", "cv-entry-org", item.org));
  e.append(el("p", "cv-period", item.period), head);
  if (item.text) e.append(el("p", "cv-entry-text", item.text));
  return e;
}

function list(items: string[], className: string): HTMLElement {
  const ul = el("ul", className);
  for (const item of items) ul.append(el("li", undefined, item));
  return ul;
}

export async function main(os: AppInterface): Promise<void> {
  const win = await os.windows.create({ title: `Resume — ${resume.name}` });
  void win.onCloseRequest(() => void os.process.exit(0));

  const page = el("main", "cv");

  // --- header
  const header = el("header", "cv-header");
  const photo = el("img", "cv-photo");
  photo.src = photoUrl;
  photo.alt = `Photo of ${resume.name}`;
  const intro = el("div", "cv-intro");
  intro.append(el("h1", "cv-name", resume.name), el("p", "cv-headline", resume.headline));

  const links = el("div", "cv-links");
  for (const link of resume.links) {
    const button = el("button", "cv-link", link.label);
    button.type = "button";
    // The app can't open links itself (sandbox); the kernel does it for us.
    button.onclick = () => {
      os.shell.openExternal(link.href).catch(() => {
        button.classList.add("is-error");
      });
    };
    links.append(button);
  }
  intro.append(links);
  header.append(photo, intro);

  // --- sections
  const languages = el("ul", "cv-languages");
  for (const lang of resume.languages) {
    const li = el("li");
    li.append(el("span", "cv-lang-name", lang.name), el("span", "cv-lang-level", lang.level));
    languages.append(li);
  }

  const skills = el("div", "cv-skills");
  skills.append(
    el("h3", "cv-subtitle", "Languages"),
    languages,
    el("h3", "cv-subtitle", "Technical skills"),
    list(resume.skills, "cv-bullets"),
    list(resume.technologies, "cv-tags"),
  );

  const footer = el("footer", "cv-footer");
  footer.append(
    el(
      "p",
      undefined,
      "This resume runs as a sandboxed app inside a small operating system I built " +
        "in the browser. Open the Terminal on the desktop to look around.",
    ),
  );

  page.append(
    header,
    section("Work experience", ...resume.experience.map(entry)),
    section("Education", ...resume.education.map(entry)),
    section("Skills", skills),
    footer,
  );
  document.body.append(page);
}
