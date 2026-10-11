import { registry } from "../../apps/registry";
import { kernelError, logError } from "../../kernel/errors";
import type { SystemInterface } from "../../kernel/syscalls/api";
import type { Rect } from "../../kernel/types";
import {
  applyAccent,
  ICON_SCALES,
  loadAutostart,
  loadIconLayout,
  loadPathList,
  loadSettings,
  saveIconLayout,
  wallpaperCSS,
  type IconLayout,
} from "../../utils/settings";
import {
  defaultAppFor,
  FILE_SVG,
  FOLDER_SVG,
  readShortcut,
} from "../../utils/filetypes";

import {
  cellKey,
  cellToPoint,
  clampCell,
  columnsFor,
  iconRect,
  intersects,
  nextFreeCell,
  pointToCell,
  rowsFor,
  setIconScale,
} from "./grid";
import {
  createIcon,
  renderFocused,
  renderPosition,
  renderSelected,
} from "./icon";
import { enableDrag } from "./interactions/drag";
import { enableKeyboard } from "./interactions/keyboard";
import { enableMarquee } from "./interactions/marquee";
import { createMenu, type ContextMenu, type MenuItem } from "./menu";
import type {
  DesktopCommands,
  DesktopIcon,
  DesktopItem,
  IconPosition,
} from "./types";

import desktopHTML from "./desktop.html?raw";
import appIconHTML from "./app-icon.html?raw";
import menuHTML from "./menu.html?raw";
import menuItemHTML from "./menu-item.html?raw";
import "./desktop.css";

/**
 * One user's session, started by /System/login with USER/HOME set. Exiting
 * is logging out: login then ends whatever the session left running.
 */
const USER_DIRS = ["Documents", "Downloads", "Pictures", "Music", "Videos"];

/** Polling stands in for fs change events, which the kernel doesn't have. */
const RESCAN_MS = 2000;

export async function main(os: SystemInterface): Promise<void> {
  const home = (await os.process.env()).HOME ?? "/";
  await os.process.chdir(home).catch(() => os.process.chdir("/"));
  // Created as the user, so they own them. Deleted ones come back next login, like XDG.
  for (const dir of USER_DIRS) await os.fs.mkdir(`${home}/${dir}`).catch(() => {});
  const folder = `${home}/Desktop`;
  await createDesktopFolder(os, folder);

  const desktop = new Desktop(os, folder, await os.display.root());
  await desktop.start();
  await autostart(os);

  await os.process.onSignal("SIGTERM", () => {
    desktop.destroy();
    void os.process.exit(0);
  });

  // From the Settings app (settings.json) or the taskbar's app menu (~/.config/desktop).
  await os.process.onSignal("SIGHUP", () => {
    void desktop.applySettings().catch(logError);
    void desktop.syncIcons().catch(logError);
  });

  await os.process.onSignal("SIGCHLD", () => void reapZombies(os));
}


/**
 * The desktop shows ~/Desktop. A new one gets a shortcut per app from the
 * old ~/.config/desktop list (or the default one), so nobody loses theirs.
 */
async function createDesktopFolder(os: SystemInterface, folder: string): Promise<void> {
  try {
    await os.fs.mkdir(folder);
  } catch {
    return; // Already there: the user's files are the truth now.
  }
  for (const exec of await loadPathList(os, "desktop")) {
    const app = registry.find((entry) => entry.exec === exec);
    if (app) await os.fs.writeTextFile(`${folder}/${app.name}.app`, `${exec}\n`).catch(logError);
  }
}

/** One program path per line; blank lines and `#` comments are skipped. */
export function autostartEntries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Starts the system list, then the user's, in order and one at a time (the
 * taskbar must be up before the launcher opens windows). A missing file or a
 * bad entry must never take the desktop down.
 */
async function autostart(os: SystemInterface): Promise<void> {
  const system = autostartEntries(await os.fs.readTextFile("/etc/autostart").catch(() => ""));
  for (const path of [...system, ...(await loadAutostart(os))]) {
    await os.process.spawn(path).catch((error) =>
      console.error(`[desktop] autostart ${path} failed:`, error),
    );
  }
}

/** SIGCHLD only says "a child died" — find out which ones. */
async function reapZombies(os: SystemInterface): Promise<void> {
  const processes = await os.process.list();
  const zombies = processes.filter(
    (proc) => proc.parentPid === os.process.pid && proc.status === "zombie",
  );

  for (const child of zombies) {
    try {
      const termination = await os.process.wait(child.pid);
      console.log(
        `[init] reaped ${child.pid} ${child.path} → ${termination.code}`,
      );
    } catch {
      // The child was already reaped.
    }
  }
}

class Desktop implements DesktopCommands {
  private readonly os: SystemInterface;
  private readonly root: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly iconLayer: HTMLElement;
  private readonly menu: ContextMenu;

  private readonly marquee: HTMLElement;
  private readonly folder: string;

  private readonly icons: DesktopIcon[] = [];
  private readonly iconDisposers = new Map<DesktopIcon, () => void>();
  private readonly disposers: Array<() => void> = [];
  private focused: DesktopIcon | null = null;
  private layout: IconLayout = {};
  private syncing: Promise<void> = Promise.resolve();

  constructor(os: SystemInterface, folder: string, root: HTMLElement) {
    this.os = os;
    this.root = root;
    this.folder = folder;
    root.innerHTML = desktopHTML;

    this.surface = this.require("#desktop");
    this.iconLayer = this.require("[data-field='icons']");
    this.marquee = this.require("[data-field='marquee']");

    this.menu = createMenu(this.surface, menuHTML, menuItemHTML);
    this.disposers.push(() => this.menu.destroy());
  }

  /** Everything that needs a syscall, so the constructor can stay sync. */
  public async start(): Promise<void> {
    // Before any icon is placed: the grid needs a laid-out container.
    await this.applyWorkArea();
    await this.applySettings();

    this.layout = await loadIconLayout(this.os);
    await this.syncIcons();

    this.disposers.push(
      enableMarquee(this.surface, this.marquee, this),
      enableKeyboard(this.surface, this),
      this.enableSurfaceMenu(),
      await this.os.events.subscribe(
        ["display.workAreaChanged"],
        () => void this.onWorkAreaChanged(),
      ),
    );
    const rescan = await this.os.timers.setInterval(
      () => void this.syncIcons().catch(logError),
      RESCAN_MS,
    );
    this.disposers.push(() => void this.os.timers.clearInterval(rescan));

    this.surface.focus();
  }

  public async applySettings(): Promise<void> {
    const settings = await loadSettings(this.os);
    this.surface.style.background = await wallpaperCSS(this.os, settings);
    applyAccent(settings, this.root.ownerDocument);

    // Keep each icon on its cell while the cells change size.
    const scale = ICON_SCALES[settings.iconSize] ?? 1;
    const cells = this.icons.map((icon) => pointToCell(icon.x, icon.y));
    setIconScale(scale);
    this.root.style.setProperty("--icon-scale", String(scale));
    this.icons.forEach((icon, i) => {
      const point = cellToPoint(cells[i]);
      this.place(icon, point.x, point.y);
    });
    this.relayoutOutOfBounds();
  }

  private async onWorkAreaChanged(): Promise<void> {
    await this.applyWorkArea();
    this.relayoutOutOfBounds();
    this.menu.close();
  }

  public destroy(): void {
    for (const dispose of [...this.disposers]) {
      try {
        dispose();
      } catch (error) {
        logError(error);
      }
    }
    this.disposers.length = 0;
    for (const dispose of this.iconDisposers.values()) dispose();
    this.iconDisposers.clear();
    this.icons.length = 0;
    this.focused = null;
    this.root.innerHTML = "";
  }

  // ------------------------------------------------------------------ layout

  private require<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) {
      throw kernelError("ENODEV", `Desktop element ${selector} not found`);
    }
    return element;
  }

  private async applyWorkArea(): Promise<void> {
    const area = await this.os.display.workArea();
    const style = this.iconLayer.style;

    style.left = `${area.x}px`;
    style.top = `${area.y}px`;
    style.width = `${area.width}px`;
    style.height = `${area.height}px`;
  }

  private addIcon(item: DesktopItem): void {
    const icon = createIcon(item, appIconHTML);
    const taken = this.takenCells();
    const saved = this.layout[item.name];
    const fits =
      saved &&
      saved.column < this.columns() &&
      saved.row < this.rows() &&
      !taken.has(cellKey(saved));
    const cell = fits ? saved : nextFreeCell(taken, this.rows());
    const point = cellToPoint(cell);

    icon.x = point.x;
    icon.y = point.y;

    this.icons.push(icon);
    this.iconLayer.appendChild(icon.element);
    renderPosition(icon);

    const disposeDrag = enableDrag(icon, this);

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!icon.selected) this.selectOnly(icon);

      const bounds = this.surface.getBoundingClientRect();
      this.openMenu(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
        icon,
      );
    };

    icon.element.addEventListener("contextmenu", onContextMenu);
    this.iconDisposers.set(icon, () => {
      disposeDrag();
      icon.element.removeEventListener("contextmenu", onContextMenu);
    });
  }

  private removeIcon(icon: DesktopIcon): void {
    this.iconDisposers.get(icon)?.();
    this.iconDisposers.delete(icon);
    icon.element.remove();
    this.icons.splice(this.icons.indexOf(icon), 1);
    if (this.focused === icon) this.focused = null;
  }

  /**
   * Match the icons to the files in ~/Desktop. Anyone may change that folder
   * (Files, the terminal, the taskbar's app menu); we rescan on a timer and
   * on SIGHUP. Queued, so two scans never add the same file twice.
   */
  public syncIcons(): Promise<void> {
    this.syncing = this.syncing.then(() => this.scan(), () => this.scan());
    return this.syncing;
  }

  private async scan(): Promise<void> {
    const entries = (await this.os.fs.readdir(this.folder).catch(() => []))
      .filter((entry) => !entry.name.startsWith("."));
    const names = new Set(entries.map((entry) => entry.name));
    for (const icon of [...this.icons]) {
      if (!names.has(icon.item.name)) this.removeIcon(icon);
    }
    for (const entry of entries) {
      if (this.icons.some((icon) => icon.item.name === entry.name)) continue;
      const path = `${this.folder}/${entry.name}`;
      const exec = (await readShortcut(this.os, path)) ?? undefined;
      const directory = entry.kind === "directory";
      this.addIcon({
        name: entry.name,
        path,
        exec,
        directory,
        label: exec ? entry.name.slice(0, -".app".length) : entry.name,
        image: exec
          ? (registry.find((app) => app.exec === exec)?.icon ?? "/assets/icons/default-app.svg")
          : undefined,
        svg: directory ? FOLDER_SVG : FILE_SVG,
      });
    }
  }

  /** Only shortcuts: deleting real files is Files' job, with its confirm. */
  private async removeShortcuts(icons: readonly DesktopIcon[]): Promise<void> {
    for (const icon of icons) {
      if (icon.item.exec) await this.os.fs.unlink(icon.item.path).catch(logError);
    }
    await this.syncIcons();
  }

  private showInFiles(): void {
    void this.os.process.spawn("/ProgramFiles/files", [this.folder]).catch(logError);
  }

  private columns(): number {
    return columnsFor(this.iconLayer.clientWidth);
  }

  private rows(): number {
    return rowsFor(this.iconLayer.clientHeight);
  }

  private takenCells(
    exclude: ReadonlySet<DesktopIcon> = new Set(),
  ): Set<string> {
    const taken = new Set<string>();
    for (const icon of this.icons) {
      if (exclude.has(icon)) continue;
      taken.add(cellKey(pointToCell(icon.x, icon.y)));
    }
    return taken;
  }

  private place(icon: DesktopIcon, x: number, y: number): void {
    icon.x = x;
    icon.y = y;
    renderPosition(icon);
  }

  private reflow(order: readonly DesktopIcon[]): void {
    const taken = new Set<string>();
    const rows = this.rows();

    for (const icon of order) {
      const cell = nextFreeCell(taken, rows);
      taken.add(cellKey(cell));
      const point = cellToPoint(cell);
      this.place(icon, point.x, point.y);
    }
    this.saveLayout();
  }

  /** Remember where the user put things, so the next login looks the same. */
  private saveLayout(): void {
    for (const icon of this.icons) {
      this.layout[icon.item.name] = pointToCell(icon.x, icon.y);
    }
    void saveIconLayout(this.os, this.layout).catch(logError);
  }

  /** After a work-area change, rescue anything now off the edge. */
  private relayoutOutOfBounds(): void {
    const columns = this.columns();
    const rows = this.rows();
    const taken = new Set<string>();
    const displaced: DesktopIcon[] = [];

    for (const icon of this.icons) {
      const cell = pointToCell(icon.x, icon.y);
      const key = cellKey(cell);

      if (cell.column >= columns || cell.row >= rows || taken.has(key)) {
        displaced.push(icon);
        continue;
      }
      taken.add(key);
    }

    for (const icon of displaced) {
      const cell = nextFreeCell(taken, rows);
      taken.add(cellKey(cell));
      const point = cellToPoint(cell);
      this.place(icon, point.x, point.y);
    }
  }

  // -------------------------------------------------------------- selection

  public selectOnly(icon: DesktopIcon): void {
    for (const other of this.icons) {
      if (other.selected === (other === icon)) continue;
      other.selected = other === icon;
      renderSelected(other);
    }
    icon.selected = true;
    renderSelected(icon);
    this.setFocus(icon);
  }

  public toggleSelect(icon: DesktopIcon): void {
    icon.selected = !icon.selected;
    renderSelected(icon);
    this.setFocus(icon);
  }

  public clearSelection(): void {
    for (const icon of this.icons) {
      if (!icon.selected) continue;
      icon.selected = false;
      renderSelected(icon);
    }
    this.setFocus(null);
  }

  public selectWithin(area: Rect): void {
    for (const icon of this.icons) {
      const selected = intersects(iconRect(icon.x, icon.y), area);
      if (icon.selected === selected) continue;
      icon.selected = selected;
      renderSelected(icon);
    }
  }

  public selectedIcons(): DesktopIcon[] {
    return this.icons.filter((icon) => icon.selected);
  }

  private setFocus(icon: DesktopIcon | null): void {
    if (this.focused === icon) return;
    if (this.focused) renderFocused(this.focused, false);
    this.focused = icon;
    if (icon) renderFocused(icon, true);
  }

  // --------------------------------------------------------------- movement

  public moveTo(positions: readonly IconPosition[]): void {
    for (const position of positions) {
      this.place(position.icon, position.x, position.y);
    }
  }

  public commitMove(moved: readonly DesktopIcon[]): void {
    const movedSet = new Set(moved);
    const taken = this.takenCells(movedSet);
    const columns = this.columns();
    const rows = this.rows();

    for (const icon of moved) {
      let cell = clampCell(pointToCell(icon.x, icon.y), columns, rows);
      if (taken.has(cellKey(cell))) cell = nextFreeCell(taken, rows);

      taken.add(cellKey(cell));
      const point = cellToPoint(cell);
      this.place(icon, point.x, point.y);
    }
    this.saveLayout();
  }

  // ---------------------------------------------------------------- actions

  public launch(icon: DesktopIcon): void {
    this.spawn([icon]);
  }

  public activateSelection(): void {
    this.spawn(this.selectedIcons());
  }

  private spawn(icons: readonly DesktopIcon[]): void {
    for (const icon of icons) {
      // A stale shortcut rejects with ENOENT. This runs inside a dblclick
      // handler, which is not a kernel callback site, so an unhandled rejection
      // would not even register as a fault — it would just vanish.
      void this.open(icon.item).catch(logError);
    }

    this.clearSelection();
  }

  /** Same rules as double-clicking it in Files. */
  private async open(item: DesktopItem): Promise<void> {
    if (item.exec) {
      await this.os.process.spawn(item.exec);
    } else if (item.directory) {
      await this.os.process.spawn("/ProgramFiles/files", [item.path]);
    } else {
      const { openWith } = await loadSettings(this.os);
      await this.os.process.spawn(defaultAppFor(item.path, openWith), [item.path]);
    }
  }

  public moveFocus(
    direction: "up" | "down" | "left" | "right",
    additive: boolean,
  ): void {
    if (this.icons.length === 0) return;

    const current = this.focused;
    if (!current) {
      this.selectOnly(this.icons[0]);
      return;
    }

    const step = {
      up: { column: 0, row: -1 },
      down: { column: 0, row: 1 },
      left: { column: -1, row: 0 },
      right: { column: 1, row: 0 },
    }[direction];

    const from = pointToCell(current.x, current.y);
    let best: DesktopIcon | null = null;
    let bestDistance = Infinity;

    for (const icon of this.icons) {
      if (icon === current) continue;

      const cell = pointToCell(icon.x, icon.y);
      const dColumn = cell.column - from.column;
      const dRow = cell.row - from.row;

      // Must lie in the half-plane we are moving toward.
      if (step.column !== 0 && Math.sign(dColumn) !== step.column) continue;
      if (step.row !== 0 && Math.sign(dRow) !== step.row) continue;

      // Off-axis drift costs triple, so "down" prefers the same column.
      const distance =
        step.column !== 0
          ? Math.abs(dColumn) + Math.abs(dRow) * 3
          : Math.abs(dRow) + Math.abs(dColumn) * 3;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = icon;
      }
    }

    if (!best) return;
    if (additive) {
      best.selected = true;
      renderSelected(best);
      this.setFocus(best);
    } else {
      this.selectOnly(best);
    }
  }

  // ------------------------------------------------------------------- menu

  private enableSurfaceMenu(): () => void {
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const bounds = this.surface.getBoundingClientRect();
      this.openMenu(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
        null,
      );
    };

    this.surface.addEventListener("contextmenu", onContextMenu);
    return () => this.surface.removeEventListener("contextmenu", onContextMenu);
  }

  public openMenu(x: number, y: number, icon: DesktopIcon | null): void {
    const selection = this.selectedIcons();

    const items: MenuItem[] = icon
      ? [
          {
            label:
              selection.length > 1 ? `Open ${selection.length} items` : "Open",
            action: () => this.activateSelection(),
          },
          selection.every((selected) => selected.item.exec)
            ? {
                label: "Remove from desktop",
                action: () => void this.removeShortcuts(selection).catch(logError),
              }
            : { label: "Show in Files", action: () => this.showInFiles() },
        ]
      : [
          { label: "Open Desktop folder", action: () => this.showInFiles() },
          {
            label: "Sort by name",
            action: () =>
              this.reflow(
                [...this.icons].sort((a, b) =>
                  a.item.label.localeCompare(b.item.label),
                ),
              ),
          },
          {
            label: "Align to grid",
            action: () => this.reflow(this.visualOrder()),
          },
          {
            label: "Log out",
            action: () => {
              this.destroy();
              void this.os.process.exit(0);
            },
          },
        ];

    this.menu.open(x, y, items);
  }

  public closeMenu(): void {
    this.menu.close();
  }

  private visualOrder(): DesktopIcon[] {
    return [...this.icons].sort((a, b) => {
      const cellA = pointToCell(a.x, a.y);
      const cellB = pointToCell(b.x, b.y);
      return cellA.column - cellB.column || cellA.row - cellB.row;
    });
  }
}
