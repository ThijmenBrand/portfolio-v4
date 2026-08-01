import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import type { WindowRecord } from "./types";

interface buildWindowChromeResult {
  rootElement: HTMLElement;
  titleElement: HTMLElement;
  bodyElement: HTMLElement;
  handles: {
    close: HTMLElement;
    maximize: HTMLElement;
    minimize: HTMLElement;
  };
}

export interface WindowChromeInterface {
  buildWindowChrome(windowHTML: string): buildWindowChromeResult;
  applyFrameToWindow(windowRecord: WindowRecord): void;
  applyStateToWindow(windowRecord: WindowRecord, isFocused: boolean): void;
  setWindowTitle(windowRecord: WindowRecord, title: string): void;
}

export class WindowChrome implements WindowChromeInterface {
  public buildWindowChrome(windowHTML: string): buildWindowChromeResult {
    const windowElement = htmlStringToTemplate(windowHTML);

    const titleElement = selectElementFromTemplate<HTMLElement>(
      windowElement,
      "#window-title",
    );
    const bodyElement = selectElementFromTemplate<HTMLElement>(
      windowElement,
      "#window-content",
    );
    const closeHandle = selectElementFromTemplate<HTMLElement>(
      windowElement,
      "#window-close-button",
    );
    const maximizeHandle = selectElementFromTemplate<HTMLElement>(
      windowElement,
      "#window-maximize-button",
    );
    const minimizeHandle = selectElementFromTemplate<HTMLElement>(
      windowElement,
      "#window-minimize-button",
    );

    return {
      rootElement: windowElement,
      titleElement: titleElement,
      bodyElement: bodyElement,
      handles: {
        close: closeHandle,
        maximize: maximizeHandle,
        minimize: minimizeHandle,
      },
    };
  }

  public applyFrameToWindow(windowRecord: WindowRecord): void {
    const { x, y, width, height } = windowRecord.frame;
    const rootElement = windowRecord.root;

    rootElement.style.left = `${x}px`;
    rootElement.style.top = `${y}px`;
    rootElement.style.width = `${width}px`;
    rootElement.style.height = `${height}px`;
  }

  public applyStateToWindow(
    windowRecord: WindowRecord,
    isFocused: boolean,
  ): void {
    const root = windowRecord.root;

    root.style.zIndex = windowRecord.zIndex.toString();

    root.classList.toggle("maximized", windowRecord.state === "maximized");
    root.classList.toggle("minimized", windowRecord.minimized);
    root.classList.toggle("focused", isFocused);
  }

  public setWindowTitle(windowRecord: WindowRecord, title: string): void {
    windowRecord.titleEl.textContent = title;
  }
}
