// The right-click menu on areas, on courses and projects, and on todos: one at a time,
// at the pointer (or under the item, from the keyboard), gone on Esc, a click
// elsewhere or when the window loses focus.
import { el } from "./ui.ts";

export interface MenuEntry {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

let menu: HTMLDivElement | null = null;
/** The item the menu is for, marked while it's open, and focused again after. */
let owner: HTMLElement | null = null;

export function closeMenu(refocus = false): void {
  if (!menu) return;
  menu.remove();
  menu = null;
  owner?.classList.remove("has-menu");
  if (refocus && owner?.isConnected) owner.focus();
  owner = null;
}

/** Opens `entries` (null is a separator) for `target`, where `event` happened. */
export function openMenu(event: MouseEvent, target: HTMLElement, entries: (MenuEntry | null)[]): void {
  event.preventDefault();
  closeMenu();
  owner = target;
  target.classList.add("has-menu");
  menu = el("div", "menu");
  menu.setAttribute("role", "menu");
  for (const entry of entries) {
    if (!entry) {
      menu.append(Object.assign(el("div", "menu-sep"), { role: "separator" }));
      continue;
    }
    const item = el("button", `menu-item${entry.danger ? " is-danger" : ""}`, entry.label);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.disabled = !!entry.disabled;
    item.addEventListener("click", () => {
      closeMenu();
      entry.action();
    });
    menu.append(item);
  }
  menu.addEventListener("keydown", onKey);
  menu.addEventListener("contextmenu", (each) => each.preventDefault());
  document.body.append(menu);

  // From the keyboard (the menu key, Shift+F10) there's no pointer: open under the item.
  const box = target.getBoundingClientRect();
  const fromKeys = event.button !== 0 && event.clientX === 0 && event.clientY === 0;
  const x = fromKeys ? box.left + 8 : event.clientX;
  const y = fromKeys ? box.bottom : event.clientY;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function onKey(event: KeyboardEvent): void {
  // The menu's keys aren't the page's shortcuts.
  event.stopPropagation();
  const items = [...menu!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeMenu(true);
  } else if (next !== undefined) {
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  }
}

document.addEventListener("pointerdown", (event) => {
  if (menu && !menu.contains(event.target as Node)) closeMenu();
});
window.addEventListener("blur", () => closeMenu());
window.addEventListener("resize", () => closeMenu());
document.addEventListener("scroll", () => closeMenu(), true);
