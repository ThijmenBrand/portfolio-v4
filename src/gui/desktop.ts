import type { AppEntry } from "../apps/registry";
import type { KernelCore } from "../kernel/core";

import desktopHtml from "./desktop.html?raw";
import appIconHtml from "./appIcons.html?raw";

export default class Desktop {
  private readonly screen: HTMLElement;
  private readonly registry: AppEntry[];
  private readonly kernel: KernelCore;

  constructor(kernel: KernelCore, registry: AppEntry[], screen: HTMLElement) {
    this.kernel = kernel;
    this.registry = registry;
    this.screen = screen;
  }

  public render() {
    this.screen.innerHTML = desktopHtml;
    this.renderAppIcons();
  }

  private renderAppIcons() {
    const appIconsContainer = this.screen.querySelector(".desktop");
    if (!appIconsContainer) {
      throw new Error("App icons container not found");
    }

    const tpl = document.createElement("template");
    tpl.innerHTML = appIconHtml.trim();
    const appIconElement = tpl.content.firstElementChild as HTMLElement;
    if (!appIconElement) {
      throw new Error("App icon template is empty");
    }

    this.registry.forEach((app) => {
      const appIconClone = appIconElement.cloneNode(true) as HTMLElement;
      const img = appIconClone.querySelector("img");
      const p = appIconClone.querySelector("p");

      if (img) {
        img.src = app.icon;
        img.alt = `${app.name} Icon`;
      }

      if (p) {
        p.textContent = app.name;
      }

      appIconsContainer.appendChild(appIconClone);
    });
  }
}
