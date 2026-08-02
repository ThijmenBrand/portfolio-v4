import type { KernelInterface } from "../../kernel/syscalls/api";
import type { Pid, WindowId } from "../../kernel/types";

import taskbarHtml from "./taskbar.html?raw";
import taskbarButtonHtml from "./taskbar-button.html?raw";
import "./taskbar.css";
import { kernelError } from "../../kernel/errors";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import { registry } from "../../apps/registry";

const DEFAULT_ICON = "/assets/icons/default-app.svg";

interface TaskWindow {
  id: WindowId;
  title: string;
  minimized: boolean;
}

interface TaskGroup {
  pid: Pid;
  path: string;
  windows: Map<WindowId, TaskWindow>;
  mru: WindowId[];
  button: HTMLElement;
  icon: HTMLImageElement;
  label: HTMLElement;
  count: HTMLElement;
}

export function main(os: KernelInterface): void {
  new Taskbar(os);
}

class Taskbar {
  private readonly os: KernelInterface;
  private readonly root: HTMLElement;
  private readonly taskList: HTMLElement;

  private readonly groups = new Map<Pid, TaskGroup>();
  private readonly paths = new Map<Pid, string>();
  private focusedPid: Pid | null = null;

  constructor(os: KernelInterface) {
    this.os = os;
    this.root = os.display.taskbar();
    this.root.innerHTML = taskbarHtml;

    const taskList = this.root.querySelector<HTMLElement>("#taskbar-tasks");
    if (!taskList) throw kernelError("ENODEV", "Taskbar task list not found");
    this.taskList = taskList;

    const bar = this.root.querySelector<HTMLElement>("#taskbar");
    if (!bar) throw kernelError("ENODEV", "Taskbar element not found");

    os.display.reserveStrut("bottom", bar.offsetHeight || 48);

    this.seed();
    this.subscribe();

    os.process.onSignal("SIGTERM", () => {
      this.root.innerHTML = "";
      os.process.exit(0);
    });
  }

  private seed(): void {
    for (const proc of this.os.process.list()) {
      this.paths.set(proc.pid, proc.path);
    }

    for (const info of this.os.windows.list()) {
      this.addWindow(info.pid, info.windowId, info.title, info.minimized);
      if (info.focused) this.setFocused(info.pid, info.windowId);
    }
  }

  private subscribe(): void {
    this.os.events.subscribe(
      [
        "window.created",
        "window.destroyed",
        "window.titleChanged",
        "window.focused",
        "window.minimized",
      ],
      (event) => {
        switch (event.type) {
          case "window.created":
            this.addWindow(event.pid, event.windowId, event.title, false);
            break;

          case "window.destroyed":
            this.removeWindow(event.pid, event.windowId);
            break;

          case "window.titleChanged": {
            const win = this.groups.get(event.pid)?.windows.get(event.windowId);
            if (win) win.title = event.title;
            this.renderGroup(event.pid);
            break;
          }

          case "window.focused":
            this.setFocused(event.pid, event.windowId);
            break;

          case "window.minimized": {
            const win = this.groups.get(event.pid)?.windows.get(event.windowId);
            if (win) win.minimized = event.minimized;
            this.renderGroup(event.pid);
            break;
          }
        }
      },
    );
  }

  private addWindow(
    pid: Pid,
    windowId: WindowId,
    title: string,
    minimized: boolean,
  ): void {
    const group = this.ensureGroup(pid);
    group.windows.set(windowId, { id: windowId, title, minimized });
    if (!group.mru.includes(windowId)) group.mru.unshift(windowId);
    this.renderGroup(pid);
  }

  private removeWindow(pid: Pid, windowId: WindowId): void {
    const group = this.groups.get(pid);
    if (!group) return;

    group.windows.delete(windowId);
    group.mru = group.mru.filter((id) => id !== windowId);

    if (group.windows.size === 0) {
      group.button.remove();
      this.groups.delete(pid);
      this.paths.delete(pid);
      if (this.focusedPid === pid) this.focusedPid = null;
      return;
    }

    this.renderGroup(pid);
  }

  private setFocused(pid: Pid, windowId: WindowId): void {
    const previous = this.focusedPid;
    this.focusedPid = pid;

    const group = this.groups.get(pid);
    if (group) {
      group.mru = [windowId, ...group.mru.filter((id) => id !== windowId)];
    }

    if (previous !== null && previous !== pid) this.renderGroup(previous);
    this.renderGroup(pid);
  }

  private activate(pid: Pid): void {
    const group = this.groups.get(pid);
    if (!group || group.windows.size === 0) return;

    const windows = [...group.windows.values()];
    const anyVisible = windows.some((win) => !win.minimized);

    if (this.focusedPid === pid && anyVisible) {
      for (const win of windows) {
        if (!win.minimized) this.os.windows.setMinimized(win.id, true);
      }
      return;
    }

    // Oldest first, so the most recently focused window ends up on top.
    // focus() also un-minimizes, so this covers restore and raise alike.
    for (const id of [...group.mru].reverse()) {
      this.os.windows.focus(id);
    }
  }

  private ensureGroup(pid: Pid): TaskGroup {
    const existing = this.groups.get(pid);
    if (existing) return existing;

    const button = htmlStringToTemplate(taskbarButtonHtml);
    const group: TaskGroup = {
      pid,
      path: this.pathFor(pid),
      windows: new Map(),
      mru: [],
      button,
      icon: selectElementFromTemplate<HTMLImageElement>(
        button,
        "#task-button-icon",
      ),
      label: selectElementFromTemplate(button, "#task-button-label"),
      count: selectElementFromTemplate(button, "#task-button-count"),
    };

    button.addEventListener("click", () => this.activate(pid));
    this.taskList.appendChild(button);
    this.groups.set(pid, group);
    return group;
  }

  private renderGroup(pid: Pid): void {
    const group = this.groups.get(pid);
    if (!group) return;

    const entry = registry.find((app) => app.exec === group.path);
    const name = entry?.name ?? group.path.split("/").pop() ?? `pid ${pid}`;
    const windows = [...group.windows.values()];

    group.icon.src = entry?.icon ?? DEFAULT_ICON;
    group.icon.alt = name;
    group.label.textContent = name;
    group.count.textContent = windows.length > 1 ? String(windows.length) : "";
    group.button.title = windows.map((win) => win.title).join("\n");

    group.button.classList.toggle("is-active", this.focusedPid === pid);
    group.button.classList.toggle(
      "is-minimized",
      windows.every((win) => win.minimized),
    );
  }

  private pathFor(pid: Pid): string {
    const cached = this.paths.get(pid);
    if (cached !== undefined) return cached;

    const proc = this.os.process.list().find((entry) => entry.pid === pid);
    const path = proc?.path ?? "";
    this.paths.set(pid, path);
    return path;
  }
}
