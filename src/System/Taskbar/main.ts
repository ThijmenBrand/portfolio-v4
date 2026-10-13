import type { SystemInterface } from "../../kernel/syscalls/api";
import type { Pid, WindowId } from "../../kernel/types";

import taskbarHtml from "./taskbar.html?raw";
import taskbarButtonHtml from "./taskbar-button.html?raw";
import appTileHtml from "./app-tile.html?raw";
import "./taskbar.css";
import { kernelError, logError } from "../../kernel/errors";
import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import { allApps, registry, type AppEntry } from "../../apps/registry";
import { ADMIN_GID } from "../../kernel/fs/perm";
import {
  clockFormat,
  loadPathList,
  loadSettings,
  setInPathList,
  type Settings,
} from "../../utils/settings";
import { shortcutsTo } from "../../utils/filetypes";
import { confirmDialog } from "../../utils/confirm";

const DEFAULT_ICON = "/assets/icons/default-app.svg";
const SETTINGS = "/ProgramFiles/settings";

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

type MenuItems = Array<[label: string, action: () => Promise<void>]>;

export async function main(os: SystemInterface): Promise<void> {
  const taskbar = new Taskbar(os, await os.display.taskbar());
  await taskbar.start();
}

class Taskbar {
  private readonly os: SystemInterface;
  private readonly root: HTMLElement;
  private readonly taskList: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly pinList: HTMLElement;

  private readonly groups = new Map<Pid, TaskGroup>();
  private readonly paths = new Map<Pid, string>();
  private focusedPid: Pid | null = null;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  private animateMinimize = true;
  private strut: { id: number; size: number } | undefined;

  /** Exec paths pinned to the dock: ~/.config/taskbar, which this process owns. */
  private pins: string[] = [];
  /** Built-in and installed apps; re-read whenever the app menu opens. */
  private apps: AppEntry[] = registry;
  private gid = -1;
  private readonly pinButtons = new Map<string, HTMLElement>();

  constructor(os: SystemInterface, root: HTMLElement) {
    this.os = os;
    this.root = root;
    this.root.innerHTML = taskbarHtml;

    const taskList = this.root.querySelector<HTMLElement>("#taskbar-tasks");
    if (!taskList) throw kernelError("ENODEV", "Taskbar task list not found");
    this.taskList = taskList;

    const bar = this.root.querySelector<HTMLElement>("#taskbar");
    if (!bar) throw kernelError("ENODEV", "Taskbar element not found");
    this.bar = bar;

    this.pinList = this.require("#taskbar-pins");
  }

  private require<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element)
      throw kernelError("ENODEV", `Taskbar element ${selector} not found`);
    return element;
  }

  /** Everything that needs a syscall, so the constructor can stay sync. */
  public async start(): Promise<void> {
    await this.startTopbar();

    this.gid = (await this.os.process.ids()).gid;
    this.apps = await allApps(this.os);
    this.startAppMenu();
    await this.loadPins();

    await this.seed();
    await this.subscribe();
    await this.startStatusItems();

    await this.os.process.onSignal("SIGTERM", () => {
      clearInterval(this.clockTimer);
      this.root.innerHTML = "";
      void this.os.process.exit(0);
    });
  }

  /**
   * The session menu. The taskbar is started by the desktop's autostart, so
   * logging out is SIGTERM to our parent: the desktop exits and login ends
   * the rest of the session, this process included.
   */
  private async startTopbar(): Promise<void> {
    const topbar = this.root.querySelector<HTMLElement>("#topbar");
    const user = this.root.querySelector<HTMLElement>("#topbar-user");
    const logout = this.root.querySelector<HTMLElement>("#session-logout");
    const clock = this.root.querySelector<HTMLTimeElement>("#topbar-clock");
    if (!topbar || !user || !logout || !clock) {
      throw kernelError("ENODEV", "Taskbar top bar not found");
    }

    await this.os.display.reserveStrut("top", topbar.offsetHeight || 28);
    user.textContent = (await this.os.process.env()).USER ?? "user";

    const initial = await loadSettings(this.os);
    let format = clockFormat(initial);
    this.animateMinimize = initial.animateMinimize;
    await this.applyDock(initial);
    const tick = (): void => {
      const now = new Date();
      clock.textContent = format.format(now);
      clock.dateTime = now.toISOString();
    };
    tick();
    this.clockTimer = setInterval(tick, 1000);

    // The Settings app sends SIGHUP after writing ~/.config/settings.json.
    await this.os.process.onSignal("SIGHUP", () => {
      void loadSettings(this.os)
        .then((settings) => {
          format = clockFormat(settings);
          tick();
          this.animateMinimize = settings.animateMinimize;
          for (const pid of this.groups.keys()) this.renderGroup(pid);
          return Promise.all([this.applyDock(settings), this.loadPins()]);
        })
        .catch(logError);
    });

    const menu = this.root.querySelector<HTMLElement>("#session-menu");
    const openSettings = (args: string[]): void => {
      menu?.hidePopover();
      void this.os.process.spawn(SETTINGS, args).catch(logError);
    };
    this.root
      .querySelector("#session-account")
      ?.addEventListener("click", () => openSettings(["account"]));
    this.root
      .querySelector("#session-settings")
      ?.addEventListener("click", () => openSettings([]));

    logout.addEventListener("click", () => {
      void this.signalDesktop("SIGTERM").catch(logError);
    });
  }

  /** Alignment and auto-hide are CSS (data-align, data-hide); the strut follows auto-hide. */
  private async applyDock(settings: Settings): Promise<void> {
    this.bar.dataset.align = settings.dockAlign;
    this.bar.dataset.hide = settings.dockHide;
    this.bar.dataset.size = settings.dockSize;
    // ponytail: phones never hide the dock (taskbar.css), but "always" still drops the strut there
    const size = settings.dockHide === "always" ? 0 : this.bar.offsetHeight || 64;
    if (size === (this.strut?.size ?? 0)) return;
    if (this.strut) await this.os.display.releaseStrut(this.strut.id);
    this.strut = size
      ? { id: await this.os.display.reserveStrut("bottom", size), size }
      : undefined;
  }

  /** Our parent is the desktop: it started us from its autostart. */
  private async signalDesktop(signal: "SIGTERM" | "SIGHUP"): Promise<void> {
    const processes = await this.os.process.list();
    const self = processes.find((proc) => proc.pid === this.os.process.pid);
    if (self) await this.os.process.kill(self.parentPid, signal);
  }

  // --------------------------------------------------------------- app menu

  private startAppMenu(): void {
    const menu = this.require("#app-menu");
    const search = this.require<HTMLInputElement>("#app-menu-search");
    const tileMenu = this.require("#tile-menu");

    // Cosmetic, like the desktop: exec of an admin app fails anyway (EACCES).
    const render = () => {
      tiles = this.apps
        .filter((app) => !app.admin || this.gid === ADMIN_GID)
        .map(tileFor);
      this.require("#app-menu-grid").replaceChildren(
        ...tiles.map(({ tile }) => tile),
      );
    };

    const tileFor = (entry: AppEntry) => {
      const tile = htmlStringToTemplate(appTileHtml);
      const icon = selectElementFromTemplate<HTMLImageElement>(
        tile,
        "#app-tile-icon",
      );
      icon.src = entry.icon;
      selectElementFromTemplate(tile, "#app-tile-label").textContent =
        entry.name;

      tile.addEventListener("click", () => {
        menu.hidePopover();
        void this.os.process.spawn(entry.exec).catch(logError);
      });
      tile.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        void this.tileMenuItems(entry)
          .then((items) => this.showMenu(tileMenu, event, items))
          .catch(logError);
      });
      return { entry, tile };
    };
    let tiles: { entry: AppEntry; tile: HTMLElement }[] = [];
    render();

    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      for (const { entry, tile } of tiles) {
        tile.hidden = !entry.name.toLowerCase().includes(query);
      }
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // Hiding the popover moves focus back to the Apps button; without this,
      // the same keypress would then click it and open the menu again.
      event.preventDefault();
      tiles.find(({ tile }) => !tile.hidden)?.tile.click();
    });

    // Ctrl/Cmd+Space. App frames forward it (iframe-entry.ts → realm.ts).
    document.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || !(event.ctrlKey || event.metaKey)) return;
      // ponytail: never removed; a killed taskbar's menu is detached, so it just no-ops
      if (!menu.isConnected) return;
      event.preventDefault();
      menu.togglePopover();
    });

    menu.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState !== "open") return;
      search.value = "";
      search.focus();
      // Pick up apps installed since (bundle --install).
      void allApps(this.os)
        .then((apps) => {
          this.apps = apps;
          render();
          search.dispatchEvent(new Event("input"));
        })
        .catch(logError);
    });
  }

  private async tileMenuItems({
    id,
    name,
    exec,
  }: AppEntry): Promise<MenuItems> {
    const folder = `${(await this.os.process.env()).HOME ?? ""}/Desktop`;
    const shortcuts = await shortcutsTo(this.os, folder, exec);
    const uninstall: MenuItems = id.startsWith("user-")
      ? [
          [
            "Uninstall",
            async () => {
              if (
                !(await confirmDialog(
                  `${name} and its desktop shortcuts will be removed.`,
                  { title: `Uninstall ${name}?`, ok: "Uninstall", danger: true },
                ))
              )
                return;
              await this.os.fs.unlink(exec);
              for (const path of shortcuts) await this.os.fs.unlink(path);
              await setInPathList(this.os, "taskbar", exec, false);
              this.apps = await allApps(this.os);
              await this.loadPins();
            },
          ],
        ]
      : [];
    return [
      this.pinItem(exec),
      [
        shortcuts.length ? "Remove from desktop" : "Add to desktop",
        async () => {
          if (shortcuts.length)
            for (const path of shortcuts) await this.os.fs.unlink(path);
          else
            await this.os.fs.writeTextFile(
              `${folder}/${name}.app`,
              `${exec}\n`,
            );
        },
      ],
      ...uninstall,
    ];
  }

  /** A popover menu at the pointer, opening upward from it. */
  private showMenu(
    menu: HTMLElement,
    event: MouseEvent,
    items: MenuItems,
  ): void {
    menu.replaceChildren(
      ...items.map(([label, action]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          menu.hidePopover();
          void action().catch(logError);
        });
        return button;
      }),
    );
    // ponytail: fixed 180px clamp for the right edge, measure the menu if items get long
    menu.style.inset = `auto auto ${innerHeight - event.clientY}px ${Math.min(event.clientX, innerWidth - 180)}px`;
    if (!menu.matches(":popover-open")) menu.showPopover();
  }

  // ------------------------------------------------------------ status items

  /** Apps' topbar icons (macOS menu bar extras). Untrusted: icons render as <img>, text as textContent. */
  private async startStatusItems(): Promise<void> {
    const bar = this.require("#topbar-status");
    const menu = this.require("#status-menu");
    const activate = (id: number, menuId: string): void => {
      void this.os.display.activateStatusItem(id, menuId).catch(logError);
    };

    const render = async (): Promise<void> => {
      const items = await this.os.display.listStatusItems();
      bar.replaceChildren(
        ...items.map((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "topbar-status-item";
          button.title = item.title;
          button.setAttribute("aria-label", item.title);
          const icon = document.createElement("img");
          icon.alt = "";
          icon.src = `data:image/svg+xml,${encodeURIComponent(item.icon)}`;
          button.append(icon);
          if (item.label) button.append(item.label);

          button.addEventListener("click", () => {
            if (!item.menu?.length) return activate(item.id, "click");
            menu.replaceChildren(
              ...item.menu.map((entry) => {
                if ("separator" in entry) return document.createElement("hr");
                const row = document.createElement("button");
                row.type = "button";
                row.textContent = `${entry.checked ? "✓ " : ""}${entry.label}`;
                row.disabled = entry.disabled === true;
                row.addEventListener("click", () => {
                  menu.hidePopover();
                  activate(item.id, entry.id);
                });
                return row;
              }),
            );
            const rect = button.getBoundingClientRect();
            menu.style.inset = `${rect.bottom + 4}px auto auto ${Math.min(rect.left, innerWidth - 180)}px`;
            menu.showPopover();
          });
          return button;
        }),
      );
    };

    await render();
    await this.os.events.subscribe(["display.statusChanged"], () => {
      void render().catch(logError);
    });
  }

  // ------------------------------------------------------------------- pins

  private pinItem(exec: string): MenuItems[number] {
    const pinned = this.pins.includes(exec);
    return [
      pinned ? "Unpin from taskbar" : "Pin to taskbar",
      async () => {
        await setInPathList(this.os, "taskbar", exec, !pinned);
        await this.loadPins();
      },
    ];
  }

  private async loadPins(): Promise<void> {
    this.pins = await loadPathList(this.os, "taskbar");
    this.pinButtons.clear();
    this.pinList.replaceChildren(
      ...this.pins.flatMap((exec) => {
        const entry = this.apps.find((app) => app.exec === exec);
        if (!entry) return [];

        const button = htmlStringToTemplate(taskbarButtonHtml);
        button.classList.add("is-pinned");
        selectElementFromTemplate<HTMLImageElement>(
          button,
          "#task-button-icon",
        ).src = entry.icon;
        selectElementFromTemplate(button, "#task-button-label").textContent =
          entry.name;
        button.addEventListener("click", () => {
          void this.os.process.spawn(exec).catch(logError);
        });
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          this.showMenu(this.require("#task-menu"), event, [
            this.pinItem(exec),
          ]);
        });
        this.pinButtons.set(exec, button);
        return [button];
      }),
    );
    // replaceChildren also dropped running buttons that sat next to their pin.
    for (const pid of this.groups.keys()) this.renderGroup(pid);
    for (const exec of this.pinButtons.keys()) this.refreshPin(exec);
  }

  /** A pin hides while its app runs: the running button takes its slot. */
  private refreshPin(exec: string): void {
    const pin = this.pinButtons.get(exec);
    if (pin)
      pin.hidden = [...this.groups.values()].some(
        (group) => group.path === exec,
      );
  }

  private async seed(): Promise<void> {
    for (const proc of await this.os.process.list()) {
      this.paths.set(proc.pid, proc.path);
    }

    for (const info of await this.os.windows.list()) {
      this.addWindow(info.pid, info.windowId, info.title, info.minimized);
      if (info.focused) this.setFocused(info.pid, info.windowId);
    }
  }

  private async subscribe(): Promise<void> {
    await this.os.events.subscribe(
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
      this.refreshPin(group.path);
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

  private async activate(pid: Pid): Promise<void> {
    const group = this.groups.get(pid);
    if (!group || group.windows.size === 0) return;

    const windows = [...group.windows.values()];
    const anyVisible = windows.some((win) => !win.minimized);

    if (this.focusedPid === pid && anyVisible) {
      for (const win of windows) {
        if (!win.minimized) await this.os.windows.setMinimized(win.id, true);
      }
      return;
    }

    // Oldest first, so the most recently focused window ends up on top.
    // focus() also un-minimizes, so this covers restore and raise alike.
    // Sequentially: the kernel decides z-order in the order it is asked.
    for (const id of [...group.mru].reverse()) {
      await this.os.windows.focus(id);
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

    button.addEventListener("click", () => {
      void this.activate(pid).catch(logError);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const path = this.groups.get(pid)?.path ?? "";
      if (!this.apps.some((app) => app.exec === path)) return;
      this.showMenu(this.require("#task-menu"), event, [this.pinItem(path)]);
    });
    this.taskList.appendChild(button);
    this.groups.set(pid, group);
    return group;
  }

  private renderGroup(pid: Pid): void {
    const group = this.groups.get(pid);
    if (!group) return;

    const entry = this.apps.find((app) => app.exec === group.path);
    const name = entry?.name ?? group.path.split("/").pop() ?? `pid ${pid}`;
    const windows = [...group.windows.values()];

    group.icon.src = entry?.icon ?? DEFAULT_ICON;
    group.icon.alt = ""; // the label is the button's name (and its hover tooltip)
    group.label.textContent = name;
    group.count.textContent = windows.length > 1 ? String(windows.length) : "";

    group.button.classList.toggle("is-active", this.focusedPid === pid);
    group.button.classList.toggle(
      "is-minimized",
      windows.every((win) => win.minimized),
    );
    // The window manager flies minimized windows into this button; no target = instant.
    if (this.animateMinimize) group.button.dataset.minimizeTarget = String(pid);
    else delete group.button.dataset.minimizeTarget;

    // Pinned apps run in their pin's slot; the rest line up after the pins.
    const pin = this.pinButtons.get(group.path);
    if (pin && group.button.parentElement !== this.pinList)
      pin.after(group.button);
    if (!pin && group.button.parentElement !== this.taskList)
      this.taskList.append(group.button);
    this.refreshPin(group.path);
  }

  /**
   * Called from synchronous render paths, so a cache miss cannot block: fill it
   * in the background and re-render the group once the path is known.
   */
  private pathFor(pid: Pid): string {
    const cached = this.paths.get(pid);
    if (cached !== undefined) return cached;

    void this.os.process
      .list()
      .then((processes) => {
        const path = processes.find((entry) => entry.pid === pid)?.path ?? "";
        this.paths.set(pid, path);

        const group = this.groups.get(pid);
        if (!group || group.path === path) return;

        group.path = path;
        this.renderGroup(pid);
      })
      .catch(logError);

    return cached ?? "";
  }
}
