import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

export interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

export interface ContextMenu {
  open(x: number, y: number, items: readonly MenuItem[]): void;
  close(): void;
  destroy(): void;
  readonly isOpen: boolean;
}

export function createMenu(
  container: HTMLElement,
  menuTemplate: string,
  itemTemplate: string,
): ContextMenu {
  const element = htmlStringToTemplate(menuTemplate);
  const list = selectElementFromTemplate(element, "[data-field='items']");
  element.hidden = true;
  container.appendChild(element);

  function open(x: number, y: number, items: readonly MenuItem[]): void {
    list.replaceChildren();

    for (const item of items) {
      if (item.separator) {
        const rule = document.createElement("li");
        rule.className = "menu-separator";
        list.appendChild(rule);
        continue;
      }

      const row = htmlStringToTemplate(itemTemplate);
      const button = selectElementFromTemplate<HTMLButtonElement>(
        row,
        "[data-field='action']",
      );
      button.textContent = item.label;
      button.disabled = item.disabled === true;
      button.addEventListener("click", () => {
        close();
        item.action?.();
      });
      list.appendChild(row);
    }

    element.hidden = false;

    // Flip back inside the container rather than overflowing it.
    const maxX = Math.max(0, container.clientWidth - element.offsetWidth);
    const maxY = Math.max(0, container.clientHeight - element.offsetHeight);
    element.style.transform = `translate(${Math.min(x, maxX)}px, ${Math.min(y, maxY)}px)`;
  }

  function close(): void {
    element.hidden = true;
    list.replaceChildren();
  }

  return {
    open,
    close,
    destroy: () => element.remove(),
    get isOpen() {
      return !element.hidden;
    },
  };
}
