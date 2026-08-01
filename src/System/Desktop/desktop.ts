import { registry, type AppEntry } from "../../apps/registry";
import type { KernelInterface } from "../../kernel/types";

import desktopHTML from "./desktop.html?raw";
import appIconHTML from "./app-icon.html?raw";
import "./desktop.css";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";

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
    const appIcon = htmlStringToTemplate(appIconHTML);
    const icon = selectElementFromTemplate<HTMLImageElement>(
      appIcon,
      "#desktop-app-icon-img",
    );
    icon.src = app.icon;

    const name = selectElementFromTemplate<HTMLParagraphElement>(
      appIcon,
      "#desktop-app-name",
    );
    name.textContent = app.name;

    appIcon.addEventListener("dblclick", () => {
      this.os.process.spawn(app.exec);
    });

    return appIcon;
  }
}
