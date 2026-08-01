export function htmlStringToTemplate(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstChild as HTMLElement;
}

export function selectElementFromTemplate<T extends HTMLElement>(
  template: HTMLElement,
  selector: string,
): T {
  const element = template.querySelector<T>(selector);
  if (!element) {
    throw new Error(
      `Element with selector "${selector}" not found in template`,
    );
  }

  return element;
}
