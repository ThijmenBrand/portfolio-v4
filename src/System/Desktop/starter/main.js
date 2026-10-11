#!/ProgramFiles/jsapp
// A tiny notes app: the starting point for your own. Press Run in Code
// (or type ./main.js in a terminal here). See README.md.
import { h, mount } from "os:ui";
import { loadNotes, saveNotes } from "./store.js";
import "./style.css";

export async function main(os) {
  const win = await os.windows.create({ title: "Notes" });
  win.onCloseRequest(() => os.process.exit(0));

  let notes = await loadNotes(os);
  const input = h("input", { placeholder: "Write a note and press Enter" });

  const render = () =>
    mount(
      h("div", { class: "toolbar" }, h("strong", null, "Notes"), h("span", { class: "spacer" }), h("span", { class: "muted" }, `${notes.length} saved`)),
      h("form", { class: "row", onsubmit: add }, input, h("button", { class: "primary" }, "Add")),
      h(
        "ul",
        { class: "list notes" },
        notes.map((note, i) =>
          h("li", null, h("span", { class: "spacer" }, note), h("button", { class: "danger", onclick: () => remove(i) }, "Delete")),
        ),
      ),
    );

  async function add(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    notes = [...notes, text];
    await saveNotes(os, notes);
    render();
    input.focus();
  }

  async function remove(index) {
    notes = notes.filter((_, i) => i !== index);
    await saveNotes(os, notes);
    render();
  }

  render();
  input.focus();
}
