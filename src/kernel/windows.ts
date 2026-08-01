import type { WindowOptions } from "./types";

export interface WindowManagerInterface {
  createWindow(options: WindowOptions): number;
  getWindow(id: number): WindowOptions | undefined;
  closeWindow(id: number): void;
}

export class WindowManager implements WindowManagerInterface {
  private readonly windowLayer: HTMLElement;

  private windows: Map<number, WindowOptions> = new Map();
  private nextWindowId: number = 1;

  constructor(windowLayer: HTMLElement) {
    this.windowLayer = windowLayer;
  }

  public createWindow(options: WindowOptions): number {
    const id = this.nextWindowId++;
    this.windows.set(id, options);
    return id;
  }

  public getWindow(id: number): WindowOptions | undefined {
    return this.windows.get(id);
  }

  public closeWindow(id: number): void {
    this.windows.delete(id);
  }
}
