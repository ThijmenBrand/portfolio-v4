/**
 * Helpers for user apps, imported as `import { h, mount } from "os:ui"`
 * (see src/runtime/jsapp.ts). The look comes from kit.css, loaded for them.
 */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
};

/**
 * Build an element: `h("button", { class: "primary", onclick }, "Save")`.
 * `on*` props become listeners, `class`/`style` work as expected, other
 * props are set as properties when the element has one (value, checked…)
 * and as attributes otherwise. Text children are text, never HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(el.style, value);
    } else if (key in el && key !== "style") {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  el.append(...flatten(children));
  return el;
}

function flatten(children: Child[]): (Node | string)[] {
  return children.flatMap((child): (Node | string)[] => {
    if (Array.isArray(child)) return flatten(child);
    if (child === null || child === undefined || child === false) return [];
    return [child instanceof Node ? child : String(child)];
  });
}

/**
 * Markup -> nodes: `mount(html(page))`, with `import page from "./page.html"`.
 * Your own markup, so it's parsed as-is; <script>s in it never run (use main.js).
 * Never pass it text you didn't write (file contents, user input): use h().
 */
export function html(markup: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content;
}

/** Replace the window's content: `mount(h("h1", null, "Hi"))`. */
export function mount(...nodes: Child[]): void {
  document.body.replaceChildren(...flatten(nodes));
}
