import type { ExitRecord, Pid } from "../../kernel/types";

import debugPsHTML from "./debug-ps.html?raw";
import processRowHTML from "./process-row.html?raw";
import historyRowHTML from "./history-row.html?raw";

import "./debug-ps.css";
import "../../ui/theme.css";

import {
  htmlStringToTemplate,
  selectElementFromTemplate,
} from "../../utils/html";
import type { Signal } from "../../kernel/proc/signals";
import { logError } from "../../kernel/errors";
import type { KernelInterface } from "../../kernel/syscalls/api";

type Tab = "running" | "terminated";
type Direction = "ascending" | "descending";

interface SortState {
  key: string;
  direction: Direction;
}

interface RunningRow {
  pid: Pid;
  parentPid: Pid;
  path: string;
  status: string;
  uptime: number;
}

interface TerminatedRow {
  pid: Pid;
  parentPid: Pid;
  path: string;
  code: number;
  reason: string;
  signal: string;
  lifetime: number;
  at: number;
}

export function main(os: KernelInterface): void {
  const handle = os.windows.create({
    title: "Process Monitor",
    width: 760,
    height: 440,
    minWidth: 520,
    minHeight: 260,
  });

  new DebugPs(os, handle);
}

class DebugPs {
  private readonly os: KernelInterface;
  private readonly root: HTMLElement;

  private readonly runningBody: HTMLElement;
  private readonly terminatedBody: HTMLElement;
  private readonly runningEmpty: HTMLElement;
  private readonly terminatedEmpty: HTMLElement;
  private readonly runningCount: HTMLElement;
  private readonly terminatedCount: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly searchInput: HTMLInputElement;

  private disposed = false;
  private frameId: number | null = null;

  private tab: Tab = "running";
  private filter = "";
  private readonly sort: Record<Tab, SortState> = {
    running: { key: "pid", direction: "ascending" },
    terminated: { key: "at", direction: "descending" },
  };

  constructor(
    os: KernelInterface,
    handle: ReturnType<KernelInterface["windows"]["create"]>,
  ) {
    this.os = os;
    this.root = htmlStringToTemplate(debugPsHTML);

    this.runningBody = this.select('[data-field="running-rows"]');
    this.terminatedBody = this.select('[data-field="terminated-rows"]');
    this.runningEmpty = this.select('[data-field="running-empty"]');
    this.terminatedEmpty = this.select('[data-field="terminated-empty"]');
    this.runningCount = this.select('[data-field="running-count"]');
    this.terminatedCount = this.select('[data-field="terminated-count"]');
    this.summary = this.select('[data-field="summary"]');
    this.searchInput = this.select<HTMLInputElement>("#debug-ps-search");

    handle.body.appendChild(this.root);
    handle.onCloseRequest(() => this.os.process.exit(0));

    this.bindEvents();
    this.render();

    this.os.events.subscribe(
      [
        "process.spawned",
        "process.exited",
        "window.created",
        "window.destroyed",
      ],
      () => this.scheduleRender(),
    );

    this.os.process.signal.addEventListener("abort", () => {
      this.disposed = true;
      if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    });
  }

  // ---------------------------------------------------------------- rendering

  private scheduleRender(): void {
    if (this.disposed || this.frameId !== null) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      if (this.disposed) return;
      this.render();
    });
  }

  private render(): void {
    const now = Date.now();

    const running: RunningRow[] = this.os.process.list().map((proc) => ({
      pid: proc.pid,
      parentPid: proc.parentPid,
      path: proc.path,
      status: proc.status,
      uptime: now - proc.startedAt,
    }));

    const terminated: TerminatedRow[] = this.os.process
      .history()
      .map((record: ExitRecord) => ({
        pid: record.pid,
        parentPid: record.parentPid,
        path: record.path,
        code: record.termination.code,
        reason: record.termination.reason,
        signal: record.termination.signal ?? "—",
        lifetime: record.termination.at - record.startedAt,
        at: record.termination.at,
      }));

    this.runningCount.textContent = String(running.length);
    this.terminatedCount.textContent = String(terminated.length);

    if (this.tab === "running") {
      this.renderRunning(running);
    } else {
      this.renderTerminated(terminated);
    }

    const zombies = running.filter((row) => row.status === "zombie").length;
    this.summary.textContent =
      `${running.length} process${running.length === 1 ? "" : "es"}` +
      (zombies > 0 ? ` · ${zombies} zombie${zombies === 1 ? "" : "s"}` : "") +
      ` · ${terminated.length} in history`;
  }

  private renderRunning(rows: RunningRow[]): void {
    const visible = this.prepare(
      rows,
      "running",
      (row) => `${row.pid} ${row.parentPid} ${row.path} ${row.status}`,
    );

    this.runningBody.replaceChildren(
      ...visible.map((row) => this.buildRunningRow(row)),
    );
    this.runningEmpty.hidden = visible.length > 0;
  }

  private renderTerminated(rows: TerminatedRow[]): void {
    const visible = this.prepare(
      rows,
      "terminated",
      (row) =>
        `${row.pid} ${row.parentPid} ${row.path} ${row.reason} ${row.signal}`,
    );

    this.terminatedBody.replaceChildren(
      ...visible.map((row) => this.buildTerminatedRow(row)),
    );
    this.terminatedEmpty.hidden = visible.length > 0;
  }

  private buildRunningRow(row: RunningRow): HTMLElement {
    const element = htmlStringToTemplate(processRowHTML);
    element.dataset.pid = String(row.pid);

    this.fill(element, "pid", String(row.pid));
    this.fill(element, "parentPid", String(row.parentPid));
    this.fill(element, "path", row.path, row.path);
    this.fill(element, "uptime", formatDuration(row.uptime));

    const status = selectElementFromTemplate(element, '[data-field="status"]');
    status.textContent = row.status;
    status.dataset.status = row.status;

    return element;
  }

  private buildTerminatedRow(row: TerminatedRow): HTMLElement {
    const element = htmlStringToTemplate(historyRowHTML);
    element.dataset.pid = String(row.pid);

    this.fill(element, "pid", String(row.pid));
    this.fill(element, "parentPid", String(row.parentPid));
    this.fill(element, "path", row.path, row.path);
    this.fill(element, "code", String(row.code));
    this.fill(element, "signal", row.signal);
    this.fill(element, "lifetime", formatDuration(row.lifetime));
    this.fill(element, "at", formatClock(row.at));

    const reason = selectElementFromTemplate(element, '[data-field="reason"]');
    reason.textContent = row.reason;
    reason.dataset.reason = row.reason;

    return element;
  }

  // ------------------------------------------------------- filtering/sorting

  private prepare<T extends RunningRow | TerminatedRow>(
    rows: T[],
    tab: Tab,
    searchable: (row: T) => string,
  ): T[] {
    const query = this.filter.trim().toLowerCase();
    const filtered = query
      ? rows.filter((row) => searchable(row).toLowerCase().includes(query))
      : rows;

    const { key, direction } = this.sort[tab];
    const sign = direction === "ascending" ? 1 : -1;

    return [...filtered].sort(
      (a, b) => sign * compare(fieldOf(a, key), fieldOf(b, key)),
    );
  }

  // ----------------------------------------------------------------- events

  private bindEvents(): void {
    for (const button of this.root.querySelectorAll<HTMLElement>(
      "[data-tab]",
    )) {
      button.addEventListener("click", () =>
        this.setTab(button.dataset.tab as Tab),
      );
    }

    this.searchInput.addEventListener("input", () => {
      this.filter = this.searchInput.value;
      this.render();
    });

    this.select('[data-action="clear-search"]').addEventListener(
      "click",
      () => {
        this.searchInput.value = "";
        this.filter = "";
        this.render();
      },
    );

    for (const head of this.root.querySelectorAll<HTMLElement>("thead")) {
      head.addEventListener("click", (event) =>
        this.onHeaderClick(event, head),
      );
    }

    this.runningBody.addEventListener("click", (event) =>
      this.onRowAction(event),
    );
  }

  private onHeaderClick(event: MouseEvent, head: HTMLElement): void {
    const target = event.target as HTMLElement | null;
    const header = target?.closest<HTMLElement>("th[data-sort]");
    if (!header || !head.contains(header)) return;

    const key = header.dataset.sort!;
    const tab = head.closest<HTMLElement>("[data-panel]")!.dataset.panel as Tab;
    const current = this.sort[tab];

    this.sort[tab] = {
      key,
      direction:
        current.key === key && current.direction === "ascending"
          ? "descending"
          : "ascending",
    };

    for (const th of head.querySelectorAll<HTMLElement>("th[data-sort]")) {
      th.setAttribute(
        "aria-sort",
        th === header ? this.sort[tab].direction : "none",
      );
    }

    this.render();
  }

  private onRowAction(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>("[data-action]");
    if (!button) return;

    const row = button.closest<HTMLElement>("[data-pid]");
    if (!row) return;

    const pid = Number(row.dataset.pid);
    const signal: Signal =
      button.dataset.action === "sigkill" ? "SIGKILL" : "SIGTERM";

    try {
      this.os.process.kill(pid as Pid, signal);
    } catch (error) {
      logError(`Failed to send ${signal} to ${pid}: ${error}`);
    }
  }

  private setTab(tab: Tab): void {
    this.tab = tab;

    for (const button of this.root.querySelectorAll<HTMLElement>(
      "[data-tab]",
    )) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }

    for (const panel of this.root.querySelectorAll<HTMLElement>(
      "[data-panel]",
    )) {
      const active = panel.dataset.panel === tab;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
      panel.setAttribute("aria-hidden", String(!active));
    }

    this.render();
  }

  // ----------------------------------------------------------------- helpers

  private select<T extends HTMLElement = HTMLElement>(selector: string): T {
    return selectElementFromTemplate<T>(this.root, selector);
  }

  private fill(
    row: HTMLElement,
    field: string,
    value: string,
    title?: string,
  ): void {
    const cell = selectElementFromTemplate(row, `[data-field="${field}"]`);
    cell.textContent = value;
    if (title !== undefined) cell.title = title;
  }
}

function fieldOf(row: RunningRow | TerminatedRow, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
