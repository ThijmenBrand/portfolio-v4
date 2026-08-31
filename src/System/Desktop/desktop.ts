import { registry, type AppEntry } from "../../apps/registry";
import { kernelError, logError } from "../../kernel/errors";
import type { KernelInterface } from "../../kernel/syscalls/api";
import type { Rect } from "../../kernel/types";

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
import type { DesktopCommands, DesktopIcon, IconPosition } from "./types";

import desktopHTML from "./desktop.html?raw";
import appIconHTML from "./app-icon.html?raw";
import menuHTML from "./menu.html?raw";
import menuItemHTML from "./menu-item.html?raw";
import "./desktop.css";

export async function main(os: KernelInterface): Promise<void> {
  const desktop = new Desktop(os, registry, os.display.root());
  await os.process.chdir("/home");

  os.process.spawn("/System/Taskbar");

  os.process.onSignal("SIGTERM", () => {
    desktop.destroy();
    os.process.exit(0);
  });

  os.process.onSignal("SIGCHLD", () => {
    const zombies = os.process
      .list()
      .filter(
        (proc) => proc.parentPid === os.process.pid && proc.status === "zombie",
      );

    for (const child of zombies) {
      os.process
        .wait(child.pid)
        .then((termination) =>
          console.log(
            `[init] reaped ${child.pid} ${child.path} → ${termination.code}`,
          ),
        )
        .catch(() => {});
    }
  });
}

class Desktop implements DesktopCommands {
  private readonly os: KernelInterface;
  private readonly root: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly iconLayer: HTMLElement;
  private readonly menu: ContextMenu;

  private readonly icons: DesktopIcon[] = [];
  private readonly disposers: Array<() => void> = [];
  private focused: DesktopIcon | null = null;

  constructor(os: KernelInterface, entries: AppEntry[], root: HTMLElement) {
    this.os = os;
    this.root = root;
    root.innerHTML = desktopHTML;

    this.surface = this.require("#desktop");
    this.iconLayer = this.require("[data-field='icons']");
    const marquee = this.require("[data-field='marquee']");

    // Before any icon is placed: the grid needs a laid-out container.
    this.applyWorkArea();

    this.menu = createMenu(this.surface, menuHTML, menuItemHTML);
    this.disposers.push(() => this.menu.destroy());

    for (const entry of entries) this.addIcon(entry);

    this.disposers.push(
      enableMarquee(this.surface, marquee, this),
      enableKeyboard(this.surface, this),
      this.enableSurfaceMenu(),
      this.os.events.subscribe(["display.workAreaChanged"], () => {
        this.applyWorkArea();
        this.relayoutOutOfBounds();
        this.menu.close();
      }),
    );

    this.surface.focus();
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

  private applyWorkArea(): void {
    const area = this.os.display.workArea();
    const style = this.iconLayer.style;

    style.left = `${area.x}px`;
    style.top = `${area.y}px`;
    style.width = `${area.width}px`;
    style.height = `${area.height}px`;
  }

  private addIcon(entry: AppEntry): void {
    const icon = createIcon(entry, appIconHTML);
    const cell = nextFreeCell(this.takenCells(), this.rows());
    const point = cellToPoint(cell);

    icon.x = point.x;
    icon.y = point.y;

    this.icons.push(icon);
    this.iconLayer.appendChild(icon.element);
    renderPosition(icon);

    this.disposers.push(enableDrag(icon, this));

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
    this.disposers.push(() =>
      icon.element.removeEventListener("contextmenu", onContextMenu),
    );
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
      try {
        this.os.process.spawn(icon.entry.exec);
      } catch (error) {
        // A stale registry path throws ENOENT. This runs inside a dblclick
        // handler, which is not a kernel callback site, so an escaping throw
        // would not even register as a fault — it would just vanish.
        logError(error);
      }
    }

    this.clearSelection();
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
        ]
      : [
          {
            label: "Sort by name",
            action: () =>
              this.reflow(
                [...this.icons].sort((a, b) =>
                  a.entry.name.localeCompare(b.entry.name),
                ),
              ),
          },
          {
            label: "Align to grid",
            action: () => this.reflow(this.visualOrder()),
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
