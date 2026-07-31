export interface WindowOptions {
  title: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface WindowHandle {
  readonly id: number;
  readonly body: HTMLElement;
  setTitle(title: string): void;
  close(): void;
  onCloseRequest(callback: () => void): void;
}

export interface Kernel {
  windows: { create(options: WindowOptions): WindowHandle };
  process: {
    readonly pid: number;
    spawn(appId: string, args?: string[]): number;
    exit(code?: number): void;
  };
}

export interface Process {
  pid: number;
  appId: string;
  parentPid?: number;
  windowIds: number[];
  startedAt: number;
}

export type AppModule = { main(os: Kernel): void | Promise<void> };
