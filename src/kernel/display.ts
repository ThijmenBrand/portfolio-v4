import { kernelError, logError } from "./errors";
import type { Rect, StrutEdge } from "./types";

interface Strut {
  id: number;
  edge: StrutEdge;
  size: number;
}

export interface DisplayInterface {
  getDesktopLayer(): HTMLElement;
  getWindowLayer(): HTMLElement;
  getTaskbarLayer(): HTMLElement;
  workArea(): Rect;
  addStrut(edge: StrutEdge, size: number): number;
  removeStrut(strutId: number): void;
  onWorkAreaChange(listener: () => void): () => void;
}

export class Display {
  private readonly screen: HTMLElement;
  private readonly struts: Map<number, Strut> = new Map();
  private readonly listeners = new Set<() => void>();
  private nextStrutId: number = 1;

  constructor(screen: HTMLElement) {
    this.screen = screen;
    window.addEventListener("resize", () => this.notify());
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

  public workArea(): Rect {
    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;

    for (const strut of this.struts.values()) {
      if (strut.edge === "top") top += strut.size;
      else if (strut.edge === "right") right += strut.size;
      else if (strut.edge === "bottom") bottom += strut.size;
      else left += strut.size;
    }

    return {
      x: left,
      y: top,
      width: Math.max(0, this.screen.offsetWidth - left - right),
      height: Math.max(0, this.screen.offsetHeight - top - bottom),
    };
  }

  public addStrut(edge: StrutEdge, size: number): number {
    const id = this.nextStrutId++;
    this.struts.set(id, { id, edge, size: Math.max(0, size) });
    this.notify();
    return id;
  }

  public removeStrut(strutId: number): void {
    if (!this.struts.delete(strutId)) return;
    this.notify();
  }

  public onWorkAreaChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        logError(`Error in work area change listener: ${error}`);
      }
    }
  }
}
