export class WindowManager {
  private readonly screen: HTMLElement;

  private windows: Map<number, Window> = new Map();
  private nextWindowId: number = 1;

  constructor(screen: HTMLElement) {
    this.screen = screen;
  }
}
