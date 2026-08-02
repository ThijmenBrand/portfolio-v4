import type { AppEntry } from "../../apps/registry";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import type { DesktopIcon } from "./types";

export function createIcon(entry: AppEntry, template: string): DesktopIcon {
  const element = htmlStringToTemplate(template);

  const image = selectElementFromTemplate<HTMLImageElement>(
    element,
    "[data-field='icon']",
  );
  image.src = entry.icon;
  image.alt = "";

  selectElementFromTemplate(element, "[data-field='label']").textContent =
    entry.name;
  element.title = entry.name;

  return { entry, element, x: 0, y: 0, selected: false };
}

export function renderPosition(icon: DesktopIcon): void {
  icon.element.style.transform = `translate(${icon.x}px, ${icon.y}px)`;
}

export function renderSelected(icon: DesktopIcon): void {
  icon.element.classList.toggle("is-selected", icon.selected);
  icon.element.setAttribute("aria-selected", String(icon.selected));
}

export function renderFocused(icon: DesktopIcon, focused: boolean): void {
  icon.element.classList.toggle("is-focused", focused);
}

export function setDragging(icon: DesktopIcon, dragging: boolean): void {
  icon.element.classList.toggle("is-dragging", dragging);
}
