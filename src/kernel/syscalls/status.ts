import { einval, eperm } from "../errors";
import type { KernelContext, Pid } from "../types";

export interface StatusItemSpec {
  icon: string;
  title: string;
  label?: string;
  menu?: StatusMenuItem[];
}

export type StatusMenuItem =
  | { id: string; label: string; disabled?: boolean; checked?: boolean }
  | { separator: true };

export interface StatusItemInfo extends StatusItemSpec {
  id: number;
  pid: Pid;
}

interface Entry {
  info: StatusItemInfo;
  resourceId: number;
  onSelect: (id: string) => void;
}

const MAX_PER_PROCESS = 5;
const stores = new WeakMap<KernelContext, Map<number, Entry>>();
let nextId = 1;

function store(ctx: KernelContext): Map<number, Entry> {
  let items = stores.get(ctx);
  if (!items) stores.set(ctx, (items = new Map()));
  return items;
}

function text(value: unknown, max: number, arg: string): string {
  if (typeof value !== "string" || value.length > max) throw einval(arg);
  return value;
}

function validate(spec: unknown): StatusItemSpec {
  if (typeof spec !== "object" || spec === null) throw einval("spec");
  const s = spec as Record<string, unknown>;
  const icon = text(s.icon, 8192, "icon");
  if (!icon.trimStart().startsWith("<svg")) throw einval("icon");
  const out: StatusItemSpec = { icon, title: text(s.title, 64, "title") };
  if (s.label !== undefined) out.label = text(s.label, 32, "label");
  if (s.menu !== undefined) {
    if (!Array.isArray(s.menu) || s.menu.length > 20) throw einval("menu");
    out.menu = s.menu.map((raw: unknown): StatusMenuItem => {
      if (typeof raw !== "object" || raw === null) throw einval("menu");
      const m = raw as Record<string, unknown>;
      if (m.separator === true) return { separator: true };
      return {
        id: text(m.id, 64, "menu.id"),
        label: text(m.label, 64, "menu.label"),
        disabled: m.disabled === true,
        checked: m.checked === true,
      };
    });
  }
  return out;
}

function owned(ctx: KernelContext, pid: Pid, id: number): Entry {
  const entry = store(ctx).get(id);
  if (!entry || entry.info.pid !== pid) throw eperm(pid, "statusItem");
  return entry;
}

const changed = (ctx: KernelContext) =>
  ctx.events.emit({ type: "display.statusChanged" });

export function addStatusItem(
  ctx: KernelContext,
  pid: Pid,
  spec: unknown,
  onSelect: (id: string) => void,
): number {
  if (typeof onSelect !== "function") throw einval("onSelect");
  const items = store(ctx);
  const mine = [...items.values()].filter((e) => e.info.pid === pid).length;
  if (mine >= MAX_PER_PROCESS) throw einval("too many status items");

  const id = nextId++;
  const resourceId = ctx.processes.registerResource(pid, "status", () => {
    items.delete(id);
    changed(ctx);
  });
  items.set(id, { info: { ...validate(spec), id, pid }, resourceId, onSelect });
  changed(ctx);
  return id;
}

export function updateStatusItem(
  ctx: KernelContext,
  pid: Pid,
  id: number,
  patch: unknown,
): void {
  const entry = owned(ctx, pid, id);
  const { id: _, pid: __, ...current } = entry.info;
  const next = validate({ ...current, ...(patch as object) });
  entry.info = { ...next, id, pid };
  changed(ctx);
}

export function removeStatusItem(
  ctx: KernelContext,
  pid: Pid,
  id: number,
): void {
  const { resourceId } = owned(ctx, pid, id);
  ctx.processes.get(pid)?.resources.get(resourceId)?.dispose();
  ctx.processes.unregisterResource(pid, resourceId);
}

export function listStatusItems(ctx: KernelContext): StatusItemInfo[] {
  return [...store(ctx).values()].map((e) => e.info);
}

export function activateStatusItem(
  ctx: KernelContext,
  id: number,
  menuId: string,
): void {
  store(ctx).get(id)?.onSelect(menuId);
}
