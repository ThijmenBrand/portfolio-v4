import type { Constraints, Rect, WindowOptions } from "./types";

export interface WindowGeometryInterface {
  initialFrame(options: WindowOptions): Rect;
  initialConstraints(options: WindowOptions): Constraints;
  resizeFrame(frame: Rect, constraints: Constraints): Rect;
  maximizeFrame(constraints: Constraints): Rect;
  cascadePosition(previousFrame: Rect, constraints: Constraints): Rect;
  clampToConstraints(frame: Rect, constraints: Constraints): Rect;
  maximizedFrame(windowLayer: HTMLElement): Rect;
}

export class WindowGeometry implements WindowGeometryInterface {
  private readonly defaultFrame = {
    x: 100,
    y: 100,
    width: 400,
    height: 300,
  };

  private readonly defaultConstraints = {
    minWidth: 100,
    minHeight: 100,
    maxWidth: 1920,
    maxHeight: 1080,
  };

  public initialFrame(options: WindowOptions): Rect {
    return {
      x: options.x ?? this.defaultFrame.x,
      y: options.y ?? this.defaultFrame.y,
      width: options.width ?? this.defaultFrame.width,
      height: options.height ?? this.defaultFrame.height,
    };
  }

  public initialConstraints(options: WindowOptions): Constraints {
    return {
      minWidth: options.minWidth ?? this.defaultConstraints.minWidth,
      minHeight: options.minHeight ?? this.defaultConstraints.minHeight,
      maxWidth: options.maxWidth ?? this.defaultConstraints.maxWidth,
      maxHeight: options.maxHeight ?? this.defaultConstraints.maxHeight,
    };
  }

  public resizeFrame(frame: Rect, constraints: Constraints): Rect {
    return {
      x: frame.x,
      y: frame.y,
      width: Math.max(
        constraints.minWidth,
        Math.min(frame.width, constraints.maxWidth),
      ),
      height: Math.max(
        constraints.minHeight,
        Math.min(frame.height, constraints.maxHeight),
      ),
    };
  }

  public maximizeFrame(constraints: Constraints): Rect {
    return {
      x: 0,
      y: 0,
      width: constraints.maxWidth,
      height: constraints.maxHeight,
    };
  }

  public cascadePosition(previousFrame: Rect): Rect {
    const offset = 30;
    const newX = previousFrame.x + offset;
    const newY = previousFrame.y + offset;

    return {
      x: newX,
      y: newY,
      width: previousFrame.width,
      height: previousFrame.height,
    };
  }

  public clampToConstraints(frame: Rect, constraints: Constraints): Rect {
    return {
      x: frame.x,
      y: frame.y,
      width: Math.max(
        constraints.minWidth,
        Math.min(frame.width, constraints.maxWidth),
      ),
      height: Math.max(
        constraints.minHeight,
        Math.min(frame.height, constraints.maxHeight),
      ),
    };
  }

  public maximizedFrame(windowLayer: HTMLElement): Rect {
    return {
      x: 0,
      y: 0,
      width: windowLayer.offsetWidth,
      height: windowLayer.offsetHeight,
    };
  }
}
