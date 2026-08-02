import { kernelError } from "./errors";

export interface DisplayInterface {
  getDesktopLayer(): HTMLElement;
  getWindowLayer(): HTMLElement;
}

export class Display {
  private readonly screen: HTMLElement;

  constructor(screen: HTMLElement) {
    this.screen = screen;
  }

  public getDesktopLayer(): HTMLElement {
    let desktopLayer = this.screen.querySelector<HTMLElement>("#desktop-layer");
    if (!desktopLayer) {
      throw kernelError("Desktop layer not found");
    }
    return desktopLayer;
  }

  public getWindowLayer(): HTMLElement {
    let windowLayer = this.screen.querySelector<HTMLElement>("#window-layer");
    if (!windowLayer) {
      throw kernelError("Window layer not found");
    }
    return windowLayer;
  }
}
