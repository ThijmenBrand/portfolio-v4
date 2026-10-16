// Calendar — subscribed calendars, read-only.
//
// Two kinds of source: an https .ics link, fetched through os.net.fetch, and
// an .ics file imported from the VFS. The syscall is admin-only, so for most
// people a link simply fails; sync.ts makes sure that failure is worded
// exactly like any other network failure, and importing a file works for
// everyone. Nothing in this file may branch on who is running it.
import type { AppInterface } from "../../kernel/syscalls/api";
import { isPhone, PHONE_QUERY } from "../../utils/phone";
import { applyAccent, loadSettings, type Settings } from "../../utils/settings";
import type { CalEvent } from "./parse.ts";
import { parseIcs } from "./parse.ts";
import { occurrencesIn, type Occurrence, type QuerySource } from "./query.ts";
import {
  guessFeedName,
  hueFor,
  MAX_SOURCES,
  newId,
  openStore,
  toIcsUrl,
  VIEWS,
  type Source,
  type Store,
  type View,
} from "./store.ts";
import { due, IMPORT_HINT, syncMany, syncOne, type SyncDeps } from "./sync.ts";
import {
  addDays,
  AGENDA_DAYS,
  midnight,
  placeNowLine,
  renderAgenda,
  renderMonth,
  renderWeek,
  sameDay,
  startOfWeek,
  type ViewContext,
} from "./views.ts";
import calendarHTML from "./calendar.html?raw";
import "../../ui/theme.css";
import "./calendar.css";

const TICK_MS = 60_000;
const HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
/** Expansion slack each side, so stepping a period is a filter, not a re-expand. */
const PAD: Record<View, number> = { month: 31, week: 7, agenda: 0 };

let os: AppInterface;
let store: Store;
let settings: Settings;
let anchor = midnight(new Date());
let focused = midnight(new Date());
let agendaSpan = AGENDA_DAYS;

/** sourceId -> its parsed events, and a counter that invalidates the cache. */
const parsed = new Map<string, CalEvent[]>();
const revisions = new Map<string, number>();

let timeFmt: Intl.DateTimeFormat;
let weekdayFmt: Intl.DateTimeFormat;
let dayMonthFmt: Intl.DateTimeFormat;
let monthFmt: Intl.DateTimeFormat;
let fullFmt: Intl.DateTimeFormat;
let rangeFmt: Intl.DateTimeFormat;

const field = (name: string) => document.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
const action = (name: string) => document.querySelector<HTMLElement>(`[data-action="${name}"]`)!;
const template = (id: string) => document.querySelector<HTMLTemplateElement>(`#${id}`)!;

// ------------------------------------------------------------ formatting --

function buildFormats(): void {
  const hour12 = !settings.clock24h;
  timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12 });
  weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  dayMonthFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  fullFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  rangeFmt = new Intl.DateTimeFormat(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

const time = (at: Date) => timeFmt.format(at);

/**
 * "Oct 12 – 18, 2026", and "Dec 28, 2026 – Jan 3, 2027" across a boundary.
 * formatRange decides how much to repeat, and in what order, per locale.
 */
function weekTitle(start: Date, days: number): string {
  return rangeFmt.formatRange(start, addDays(start, days - 1));
}

// ----------------------------------------------------------------- state --

const view = (): View => store.data.view;
const weekDays = (): number => (isPhone() ? 3 : 7);

function enabledSources(): QuerySource[] {
  return store.data.sources
    .filter((source) => source.enabled)
    .map((source) => ({
      id: source.id,
      name: source.name,
      hue: hueFor(source),
      events: parsed.get(source.id) ?? [],
    }));
}

let cacheKey = "";
const windows = new Map<string, Occurrence[]>();

function revKey(): string {
  return store.data.sources
    .map((s) => `${s.id}:${s.enabled ? 1 : 0}:${revisions.get(s.id) ?? 0}`)
    .join(",");
}

/**
 * Expansion is the expensive part, so it runs for a padded range and every
 * repaint inside that range is a filter. Stepping to the next month is then
 * free, which is what makes the arrows feel instant.
 */
function occurrences(from: Date, to: Date): Occurrence[] {
  const key = revKey();
  if (key !== cacheKey) {
    windows.clear();
    cacheKey = key;
  }
  const pad = PAD[view()];
  const lo = addDays(from, -pad);
  const hi = addDays(to, pad);
  const windowKey = `${lo.getTime()}:${hi.getTime()}`;
  let items = windows.get(windowKey);
  if (!items) {
    items = occurrencesIn(enabledSources(), lo, hi);
    if (windows.size >= 4) windows.delete(windows.keys().next().value!);
    windows.set(windowKey, items);
  }
  return items.filter((o) => o.start < to && o.end > from);
}

function context(): ViewContext {
  return {
    occurrences,
    time,
    weekday: (at) => weekdayFmt.format(at),
    dayMonth: (at) => dayMonthFmt.format(at),
    today: midnight(new Date()),
    focused,
    weekDays: weekDays(),
    openDetail,
    openDay: (day) => {
      anchor = midnight(day);
      focused = anchor;
      agendaSpan = AGENDA_DAYS;
      setView("agenda");
    },
    focusDay: (day) => {
      focused = midnight(day);
      render();
    },
  };
}

// ---------------------------------------------------------------- render --

function render(): void {
  const month = field("month");
  const week = field("week");
  const agenda = field("agenda");
  const empty = field("empty");
  const current = view();

  const hasSources = store.data.sources.length > 0;
  empty.hidden = hasSources;
  month.hidden = !hasSources || current !== "month";
  week.hidden = !hasSources || current !== "week";
  agenda.hidden = !hasSources || current !== "agenda";

  for (const name of VIEWS) {
    action(`view-${name}`).setAttribute("aria-pressed", String(name === current));
  }

  if (hasSources) {
    const ctx = context();
    if (current === "month") {
      field("title").textContent = monthFmt.format(anchor);
      renderMonth(month, anchor, ctx);
    } else if (current === "week") {
      const days = weekDays();
      const start = days === 7 ? startOfWeek(anchor) : midnight(anchor);
      field("title").textContent = weekTitle(start, days);
      renderWeek(week, template("week-chrome"), anchor, ctx);
      placeNowLine(week, anchor, ctx);
    } else {
      field("title").textContent = `From ${fullFmt.format(anchor)}`;
      renderAgenda(agenda, anchor, agendaSpan, ctx, () => {
        agendaSpan += AGENDA_DAYS;
        render();
      });
    }
  } else {
    field("title").textContent = monthFmt.format(anchor);
  }

  renderSources();
}

function setView(next: View): void {
  store.data.view = next;
  store.save();
  render();
}

// --------------------------------------------------------------- sidebar --

let editing: Source | "new" | null = null;

function ago(at: number): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) return format.format(Math.round(value), unit);
    value /= step;
  }
  return format.format(Math.round(value), "week");
}

function renderSources(): void {
  const list = field("sources");
  const frag = document.createDocumentFragment();

  for (const source of store.data.sources) {
    if (editing === source) {
      frag.append(editorFor(source));
      continue;
    }
    const row = template("source-row").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
    row.style.setProperty("--hue", String(hueFor(source)));
    if (!source.enabled) row.classList.add("is-off");
    row.querySelector<HTMLElement>('[data-field="name"]')!.textContent = source.name;

    const note = row.querySelector<HTMLElement>('[data-field="note"]')!;
    if (source.lastError) {
      note.classList.add("is-error");
      // The same sentence and the same way out for everyone: a link failing
      // because the caller isn't admin must read exactly like a dead host.
      note.textContent = `${source.lastError} `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void refresh([source]));
      note.append(retry);
      if (source.kind === "url") row.title = `${source.lastError} ${IMPORT_HINT}`;
    } else if (source.lastSync) {
      note.textContent = `Synced ${ago(source.lastSync)}`;
    } else {
      note.textContent = "Not synced yet";
    }

    const toggle = row.querySelector<HTMLInputElement>('[data-action="toggle"]')!;
    toggle.checked = source.enabled;
    toggle.setAttribute("aria-label", `Show ${source.name}`);
    toggle.addEventListener("change", () => {
      source.enabled = toggle.checked;
      store.save();
      render();
    });
    row.querySelector<HTMLElement>('[data-action="menu"]')!.addEventListener("click", () => {
      editing = source;
      renderSources();
    });
    frag.append(row);
  }

  if (editing === "new") frag.append(editorFor(null));
  list.replaceChildren(frag);
  action("add").hidden = editing !== null || store.data.sources.length >= MAX_SOURCES;
}

function editorFor(existing: Source | null): HTMLLIElement {
  const node = template("source-editor").content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const pick = <T extends HTMLElement>(selector: string) => node.querySelector<T>(selector)!;
  const urlInput = pick<HTMLInputElement>('input[name="url"]');
  const nameInput = pick<HTMLInputElement>('input[name="name"]');
  const error = pick('[data-field="error"]');

  let kind: Source["kind"] = existing?.kind ?? "url";
  let path = existing?.path ?? "";
  let hue = existing?.hue;

  if (existing) {
    urlInput.value = existing.url ?? "";
    nameInput.value = existing.name;
    pick<HTMLButtonElement>('[data-action="save"]').textContent = "Save";
    pick<HTMLElement>('[data-action="remove"]').hidden = false;
  }

  const showKind = (): void => {
    pick('[data-action="kind-url"]').setAttribute("aria-pressed", String(kind === "url"));
    pick('[data-action="kind-file"]').setAttribute("aria-pressed", String(kind === "file"));
    pick(".url-only").hidden = kind !== "url";
    pick(".file-only").hidden = kind === "file" ? false : true;
    const button = pick<HTMLButtonElement>('[data-action="pick"]');
    button.textContent = path ? path.split("/").at(-1)! : "Choose file…";
  };
  showKind();

  const hues = pick('[data-field="hues"]');
  const paintHues = (): void => {
    hues.replaceChildren();
    for (const value of HUES) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "hue";
      swatch.style.setProperty("--hue", String(value));
      swatch.setAttribute("aria-label", `Colour ${value}`);
      swatch.setAttribute("aria-pressed", String(hue === value));
      swatch.addEventListener("click", () => {
        hue = hue === value ? undefined : value;
        paintHues();
      });
      hues.append(swatch);
    }
  };
  paintHues();

  const close = (): void => {
    editing = null;
    renderSources();
  };

  const fail = (message: string, culprit?: HTMLElement): void => {
    error.textContent = message;
    error.hidden = false;
    culprit?.setAttribute("aria-invalid", "true");
    culprit?.focus();
  };

  const commit = (): void => {
    error.hidden = true;
    urlInput.removeAttribute("aria-invalid");

    let url: URL | null = null;
    if (kind === "url") {
      url = toIcsUrl(urlInput.value);
      if (!url) return fail("Enter a calendar link, like example.com/calendar.ics.", urlInput);
    } else if (!path) {
      return fail("Choose an .ics file to import.");
    }

    const name = nameInput.value.trim().slice(0, 60);
    const source: Source = existing ?? {
      id: newId(),
      kind,
      name: "",
      enabled: true,
      refreshMinutes: 60,
    };
    source.kind = kind;
    if (kind === "url") {
      source.url = url!.href;
      delete source.path;
    } else {
      source.path = path;
      delete source.url;
    }
    if (name) {
      source.renamed = source.name !== "" && name !== source.name ? true : source.renamed;
      source.name = name;
    } else if (!source.name) {
      source.name = kind === "url" ? guessFeedName(url!) : guessFeedName(path);
    }
    if (hue === undefined) delete source.hue;
    else source.hue = hue;

    if (!existing) store.data.sources.push(source);
    store.save();
    close();
    bumpAll();
    render();
    void refresh([source]);
  };

  pick('[data-action="kind-url"]').addEventListener("click", () => { kind = "url"; showKind(); });
  pick('[data-action="kind-file"]').addEventListener("click", () => { kind = "file"; showKind(); });
  pick('[data-action="pick"]').addEventListener("click", () => {
    // DialogOptions has no extension filter, so an .ics is confirmed after
    // the pick, by sniffing the body in sync.ts.
    void os.dialog.open({ kind: "file", title: "Import calendar" }).then((picked) => {
      if (!picked) return;
      path = picked;
      if (!nameInput.value) nameInput.value = guessFeedName(picked);
      showKind();
    });
  });
  pick('[data-action="save"]').addEventListener("click", commit);
  pick('[data-action="cancel"]').addEventListener("click", close);
  pick('[data-action="remove"]').addEventListener("click", () => {
    if (!existing) return;
    remove(existing);
    close();
  });

  // ponytail: no <form> submit; the realm sandbox lacks allow-forms (see apps/code)
  node.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      commit();
    }
  });

  queueMicrotask(() => (kind === "url" ? urlInput : nameInput).focus());
  return node;
}

function remove(source: Source): void {
  const index = store.data.sources.indexOf(source);
  if (index < 0) return;
  const body = parsed.get(source.id);
  store.data.sources.splice(index, 1);
  parsed.delete(source.id);
  void store.dropCache(source.id);
  store.save();
  bumpAll();
  render();
  showStatus(`Removed ${source.name}.`, false, () => {
    store.data.sources.splice(Math.min(index, store.data.sources.length), 0, source);
    if (body) parsed.set(source.id, body);
    store.save();
    bumpAll();
    render();
    void refresh([source]);
  });
}

// ------------------------------------------------------------------ sync --

function bump(id: string): void {
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
}
function bumpAll(): void {
  for (const source of store.data.sources) bump(source.id);
  cacheKey = "";
  windows.clear();
}

function deps(): SyncDeps {
  return {
    os,
    store,
    onChange: (source, body) => {
      if (body !== null) {
        parsed.set(source.id, parseIcs(body).events);
        bump(source.id);
      }
      render();
    },
  };
}

async function refresh(sources: readonly Source[]): Promise<void> {
  const wanted = sources.filter((source) => source.enabled);
  if (!wanted.length) return;
  showStatus(wanted.length === 1 ? `Syncing ${wanted[0]!.name}…` : "Syncing…");
  await syncMany(deps(), wanted);
  const failed = wanted.filter((source) => source.lastError);
  if (failed.length) showStatus(failed[0]!.lastError!, true);
  else showStatus("");
}

/** Reads each cached body so the views draw before any network happens. */
async function hydrate(): Promise<void> {
  for (const source of store.data.sources) {
    const body = await store.readCache(source.id);
    if (body === null) continue;
    parsed.set(source.id, parseIcs(body).events);
    bump(source.id);
    render();
    // Yield between calendars: a small holidays feed should appear while a
    // large work feed is still parsing.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------- detail --

function openDetail(occurrence: Occurrence, anchorEl: HTMLElement): void {
  const dialog = field("detail") as HTMLDialogElement;
  dialog.style.setProperty("--hue", String(occurrence.hue));
  field("detail-title").textContent = occurrence.event.summary || "(no title)";

  const sameStartDay = sameDay(occurrence.start, addDays(occurrence.end, occurrence.allDay ? -1 : 0));
  field("detail-when").textContent = occurrence.allDay
    ? sameStartDay
      ? `All day · ${fullFmt.format(occurrence.start)}`
      : `All day · ${dayMonthFmt.format(occurrence.start)} – ${dayMonthFmt.format(addDays(occurrence.end, -1))}`
    : `${fullFmt.format(occurrence.start)} · ${time(occurrence.start)} – ${time(occurrence.end)}`;

  const where = field("detail-where");
  where.hidden = !occurrence.event.location;
  where.textContent = occurrence.event.location;

  const description = field("detail-desc");
  description.hidden = !occurrence.event.description;
  description.textContent = occurrence.event.description;

  field("detail-swatch").style.setProperty("--hue", String(occurrence.hue));
  field("detail-calendar").textContent = occurrence.sourceName;

  const open = action("open-link") as HTMLButtonElement;
  open.hidden = !occurrence.event.url;
  open.onclick = () => void os.shell.openExternal(occurrence.event.url);

  (action("copy") as HTMLButtonElement).onclick = () => {
    const lines = [
      occurrence.event.summary || "(no title)",
      field("detail-when").textContent ?? "",
      occurrence.event.location,
      occurrence.event.description,
    ].filter(Boolean);
    void os.clipboard.writeText(lines.join("\n")).then(
      () => showStatus("Copied."),
      () => showStatus("Couldn't copy.", true),
    );
  };

  dialog.showModal();
  if (!isPhone()) {
    const box = anchorEl.getBoundingClientRect();
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    dialog.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(box.bottom + 4, innerHeight - height - 8))}px`;
    dialog.style.position = "fixed";
  } else {
    dialog.style.position = "";
    dialog.style.left = "";
    dialog.style.top = "";
  }
}

// ---------------------------------------------------------------- status --

let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(text: string, isError = false, undo?: () => void): void {
  const status = field("status");
  field("status-text").textContent = text;
  status.classList.toggle("is-error", isError);
  const button = action("undo") as HTMLButtonElement;
  button.hidden = !undo;
  if (undo) {
    button.onclick = () => {
      button.hidden = true;
      field("status-text").textContent = "";
      undo();
    };
  }
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      if (field("status-text").textContent === text) {
        field("status-text").textContent = "";
        button.hidden = true;
      }
    }, undo ? 8000 : 4000);
  }
}

// -------------------------------------------------------------- movement --

function step(direction: number): void {
  const current = view();
  if (current === "month") {
    anchor = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
    focused = anchor;
  } else if (current === "week") {
    anchor = addDays(anchor, direction * weekDays());
    focused = anchor;
  } else {
    anchor = addDays(anchor, direction * 7);
    focused = anchor;
    agendaSpan = AGENDA_DAYS;
  }
  render();
}

function goToday(): void {
  anchor = midnight(new Date());
  focused = anchor;
  agendaSpan = AGENDA_DAYS;
  render();
}

function moveFocus(days: number): void {
  focused = addDays(focused, days);
  if (view() === "month" && focused.getMonth() !== anchor.getMonth()) {
    anchor = new Date(focused.getFullYear(), focused.getMonth(), 1);
  } else if (view() === "week") {
    anchor = focused;
  }
  render();
  document.querySelector<HTMLElement>(".cell[tabindex='0']")?.focus();
}

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, select, textarea, .editor, dialog")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key) {
    case "t": case "T": goToday(); break;
    case "ArrowLeft": event.preventDefault(); if (view() === "month") moveFocus(-1); else step(-1); break;
    case "ArrowRight": event.preventDefault(); if (view() === "month") moveFocus(1); else step(1); break;
    case "ArrowUp": if (view() === "month") { event.preventDefault(); moveFocus(-7); } break;
    case "ArrowDown": if (view() === "month") { event.preventDefault(); moveFocus(7); } break;
    case "Home": if (view() === "month") { event.preventDefault(); moveFocus(-((focused.getDay() + 6) % 7)); } break;
    case "End": if (view() === "month") { event.preventDefault(); moveFocus(6 - ((focused.getDay() + 6) % 7)); } break;
    case "PageUp": event.preventDefault(); step(-1); break;
    case "PageDown": event.preventDefault(); step(1); break;
    case "m": case "M": setView("month"); break;
    case "w": case "W": setView("week"); break;
    case "a": case "A": setView("agenda"); break;
    case "r": case "R": void refresh(store.data.sources); break;
    case "Escape": {
      const side = field("side");
      if (editing !== null) { editing = null; renderSources(); }
      else if (isPhone() && !side.hidden) side.hidden = true;
      break;
    }
    default: return;
  }
}

// ------------------------------------------------------------------ main --

export async function main(appOs: AppInterface, args: string[] = []): Promise<void> {
  os = appOs;
  settings = await loadSettings(os);
  applyAccent(settings);
  buildFormats();

  const handle = await os.windows.create({ title: "Calendar" });
  void handle.onCloseRequest(() => void os.process.exit(0));
  document.body.innerHTML = calendarHTML;

  store = await openStore(os, (message) => showStatus(message, true));

  // One SIGHUP handler, not followAccent's: a process gets a single handler
  // per signal, and we need the clock preference re-read as well as the
  // accent. An unhandled SIGHUP would kill us outright.
  await os.process.onSignal("SIGHUP", () => {
    void loadSettings(os).then((next) => {
      settings = next;
      applyAccent(settings);
      buildFormats();
      // The week's hour gutter is built once, so it has to go to be rebuilt.
      field("week").replaceChildren();
      render();
    });
  });

  action("today").addEventListener("click", goToday);
  action("prev").addEventListener("click", () => step(-1));
  action("next").addEventListener("click", () => step(1));
  action("refresh").addEventListener("click", () => void refresh(store.data.sources));
  for (const name of VIEWS) {
    action(`view-${name}`).addEventListener("click", () => setView(name));
  }
  action("sources").addEventListener("click", () => {
    field("side").hidden = !field("side").hidden;
  });
  const startAdd = (kind: "url" | "file"): void => {
    editing = "new";
    renderSources();
    // Switch the editor to File first: clicking the picker alone would leave
    // it on Link, and the save would then ask for an address.
    if (kind === "file") {
      queueMicrotask(() => {
        action("kind-file").click();
        action("pick").click();
      });
    }
  };
  action("add").addEventListener("click", () => startAdd("url"));
  action("add-link").addEventListener("click", () => startAdd("url"));
  action("add-file").addEventListener("click", () => startAdd("file"));
  action("close-detail").addEventListener("click", () =>
    (field("detail") as HTMLDialogElement).close(),
  );
  field("detail").addEventListener("click", (event) => {
    if (event.target === field("detail")) (field("detail") as HTMLDialogElement).close();
  });
  document.addEventListener("keydown", onKey);

  const phone = matchMedia(PHONE_QUERY);
  field("side").hidden = phone.matches;
  phone.addEventListener("change", () => {
    field("side").hidden = phone.matches;
    field("week").replaceChildren(); // the column count changed
    render();
  });
  addEventListener("resize", () => render());

  render();
  await hydrate();
  render();

  // An .ics passed on the command line (Files' "open with") is imported.
  const given = args.find((arg) => arg.endsWith(".ics"));
  if (given && !store.data.sources.some((source) => source.path === given)) {
    const source: Source = {
      id: newId(),
      kind: "file",
      path: given,
      name: guessFeedName(given),
      enabled: true,
      refreshMinutes: 60,
    };
    store.data.sources.push(source);
    store.save();
    await refresh([source]);
  }

  void refresh(due(store.data.sources, Date.now()));

  await os.timers.setInterval(() => {
    if (view() === "week") placeNowLine(field("week"), anchor, context());
    renderSources();
    void syncDue();
  }, TICK_MS);
}

async function syncDue(): Promise<void> {
  const wanted = due(store.data.sources, Date.now());
  for (const source of wanted) await syncOne(deps(), source);
}
