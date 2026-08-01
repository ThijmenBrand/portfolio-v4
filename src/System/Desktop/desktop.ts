import { registry, type AppEntry } from "../../apps/registry";
import type { KernelInterface } from "../../kernel/types";

import desktopHTML from "./desktop.html?raw";
import appIconHTML from "./app-icon.html?raw";
import "./desktop.css";

export function main(os: KernelInterface): void {
  const root = os.display.root();
  new Desktop(os, registry, root);
}

class Desktop {
  private readonly os: KernelInterface;
  private readonly registry: AppEntry[];
  private readonly desktopLayer: HTMLElement;

  constructor(os: KernelInterface, registry: AppEntry[], root: HTMLElement) {
    this.os = os;
    this.registry = registry;
    this.desktopLayer = root;

    const desktopElement = this.boot();
    this.render(desktopElement);
  }

  private boot(): HTMLDivElement {
    this.desktopLayer.innerHTML = desktopHTML;
    const desktopElement =
      this.desktopLayer.querySelector<HTMLDivElement>("#desktop");

    if (!desktopElement) {
      throw new Error("Desktop element not found");
    }
    return desktopElement;
  }

  private render(desktopElement: HTMLDivElement): void {
    const appContainer =
      desktopElement.querySelector<HTMLDivElement>("#app-container");
    if (!appContainer) {
      throw new Error("App container not found");
    }

    this.registry.forEach((app) => {
      const appIcon = this.renderAppIcon(app);
      appContainer.appendChild(appIcon);
    });
  }

  private renderAppIcon(app: AppEntry): HTMLElement {
    const template = document.createElement("template");
    template.innerHTML = appIconHTML.trim();
    const appIcon = template.content.firstElementChild as HTMLElement;
    const icon = appIcon.querySelector(
      "#desktop-app-icon-img",
    ) as HTMLImageElement;
    if (icon) {
      icon.src = app.icon;
    }
    const name = appIcon.querySelector(
      "#desktop-app-name",
    ) as HTMLParagraphElement;
    if (name) {
      name.textContent = app.name;
    }

    appIcon.addEventListener("dblclick", () => {
      this.os.process.spawn(app.exec);
    });

    return appIcon;
  }
}
