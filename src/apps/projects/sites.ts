// The shortcuts row a project's page and an area's overview both open with:
// a chip per site, keys 1 to 9 to open them, and a line to add one.
import { guessName, hostOf, hueOf, initialOf, toUrl } from "../shortcuts/site";
import { app } from "./state.ts";
import { MAX_SHORTCUTS, type Area, type Project } from "./store.ts";
import { button, el, heading, ICONS, withIcon } from "./ui.ts";

/** The area or project whose "Add site" line is open; only ever one, on its own page. */
let addingSite = "";

/** Opens an area's or project's site in a new tab. */
export function openSite(url: string): void {
  void app.os.shell.openExternal(url).catch(() => app.status("Couldn't open that site."));
}

export function shortcutsSection(owner: Area | Project): HTMLElement {
  const node = el("section", "group-list");
  const count = owner.shortcuts.length;
  node.append(heading("Shortcuts", count > 1 ? `press 1–${count}` : count ? "press 1" : ""));
  const row = el("div", "sites");
  for (const [index, site] of owner.shortcuts.entries()) {
    const chip = button("site", "", () => openSite(site.url));
    const url = toUrl(site.url);
    const mono = el("span", "site-mono", initialOf(site.name));
    mono.style.background = `oklch(0.55 0.13 ${hueOf(url ? hostOf(url) : site.url)})`;
    chip.append(mono, el("span", "", site.name), el("kbd", "", String(index + 1)));
    chip.title = site.url;
    row.append(chip);
  }
  if (addingSite === owner.id) {
    const form = el("div", "site-add");
    const input = el("input");
    input.type = "text";
    input.placeholder = "Address, e.g. tuwel.tuwien.ac.at";
    input.setAttribute("aria-label", "Site address");
    input.spellcheck = false;
    const done = (): void => {
      addingSite = "";
      app.render();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") done();
      if (event.key !== "Enter") return;
      const url = toUrl(input.value);
      if (!url) {
        app.status("That isn't an address that can be opened (https or mailto).");
        return;
      }
      const site = { name: guessName(url), url: url.href };
      app.save(
        app.projects.update((data) => {
          // Ids never repeat across areas and projects (parseData sees to it).
          const found = [...data.areas, ...data.projects].find((each) => each.id === owner.id);
          if (found && found.shortcuts.length < MAX_SHORTCUTS) found.shortcuts.push(site);
        }),
        "projects",
      );
      done();
    });
    input.addEventListener("blur", () => setTimeout(done, 100));
    form.append(input);
    row.append(form);
    requestAnimationFrame(() => input.focus());
  } else if (owner.shortcuts.length < MAX_SHORTCUTS) {
    row.append(
      button("site is-add", withIcon(ICONS.plus, "Add site"), () => {
        addingSite = owner.id;
        app.render();
      }),
    );
  }
  node.append(row);
  return node;
}
