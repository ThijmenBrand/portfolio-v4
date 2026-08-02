import { kernelError } from "./errors";

export interface DisplayInterface {
  getDesktopLayer(): HTMLElement;
  getWindowLayer(): HTMLElement;
  getTaskbarLayer(): HTMLElement;
}

export class Display {
  private readonly screen: HTMLElement;

  constructor(screen: HTMLElement) {
    this.screen = screen;
  }

  public getDesktopLayer(): HTMLElement {
    let desktopLayer = this.screen.querySelector<HTMLElement>("#desktop-layer");
    if (!desktopLayer) {
      throw kernelError("ENODEV", "Desktop layer not found");
    }
    return desktopLayer;
  }

  public getWindowLayer(): HTMLElement {
    let windowLayer = this.screen.querySelector<HTMLElement>("#window-layer");
    if (!windowLayer) {
      throw kernelError("ENODEV", "Window layer not found");
    }
    return windowLayer;
  }

  public getTaskbarLayer(): HTMLElement {
    let taskbarLayer = this.screen.querySelector<HTMLElement>("#taskbar-layer");
    if (!taskbarLayer) {
      throw kernelError("ENODEV", "Taskbar layer not found");
    }
    return taskbarLayer;
  }
}
