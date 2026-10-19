// What the Projects app keeps on disk, apart from the todos themselves:
//
//   /mnt/cloud/projects/projects.json   areas and projects, on the server,
//                                       for whoever that mount lets in
//   ~/.config/projects.json             the same, in this browser, for
//                                       everyone else
//
// and next to it a folder per project for its notes (markdown files):
//
//   /mnt/cloud/projects/<folder>/       with the cloud file
//   ~/Projects/<folder>/                with the local one
//
// One place, never both, decided once on open by trying the mount -- the same
// test the Todo app makes, so the two always agree. A refusal is a storage
// answer, not an answer about who is running the app.
//
// Todos, goals and their parts are not here: they are ordinary todos in the
// Todo app's file (../todo/store.ts), carrying a project id, so the Todo app
// and the Calendar keep showing them. The Calendar also reads this file, for
// the colour each project's todos are drawn in.
//
// Nothing here trusts the file: someone may have edited it by hand, and
// `folder` becomes part of a path.
import type { AppInterface } from "../../kernel/syscalls/api";
import { ensureConfigDir } from "../../utils/settings";
import { TIME, type Rule } from "../shortcuts/schedule";
import { toUrl } from "../shortcuts/site";

const CLOUD_DIR = "/mnt/cloud/projects";
const CLOUD_FILE = `${CLOUD_DIR}/projects.json`;

export const MAX_AREAS = 12;
export const MAX_PROJECTS = 200;
export const MAX_SHORTCUTS = 9;
export const MAX_NAME = 60;
export const MAX_CODE = 16;
export const MAX_RULES = 12;

export type Backing = "cloud" | "local";

export interface Shortcut {
  name: string;
  /** https: or mailto:, as toUrl() in ../shortcuts/site.ts accepts. */
  url: string;
}

/** A course's tie to the calendar its sessions are in. */
export interface Link {
  /** Where to look: a subscription id, "mine:<id>" for one of your own, "" for every calendar. */
  calendar: string;
  /** Session types left out, by their key ("UE"). */
  skip: string[];
  /** Open this course while one of its sessions is on. */
  open: boolean;
  /** Its sessions count as busy when looking for room to plan. */
  busy: boolean;
  /** Move the course to Ended once its last session is over. */
  end: boolean;
}

export interface Project {
  id: string;
  area: string;
  kind: "course" | "project";
  name: string;
  /** A course's code ("SOS"): how its sessions are found in the calendar. */
  code: string;
  /** 0..359; drawn as oklch() like the Calendar's colours. */
  hue: number;
  shortcuts: Shortcut[];
  /** Courses only. */
  link?: Link;
  /**
   * Ended by hand (true) or kept open by hand (false). Unset: a linked
   * course ends on its own after its last session, a project never does.
   */
  ended?: boolean;
  /** The notes folder, relative to the store's root. Fixed when the project is made. */
  folder: string;
}

export interface Area {
  id: string;
  name: string;
  hue: number;
  /** An https link to an image shown in place of the colour tile; absent for none. */
  icon?: string;
  /** When this area opens on its own: the Shortcuts app's rules, same meaning. */
  rules: Rule[];
  /**
   * The area's own calendar (work meetings, a uni timetable), as a course's
   * Link names one; "" for none. Its events are drawn in the area's colour,
   * and new courses here look for their sessions in it.
   */
  calendar: string;
  /** Open this area while one of its calendar's events is on. */
  openDuring: boolean;
  /** Sites for the whole area, opened from its overview as a project's are from its page. */
  shortcuts: Shortcut[];
}

export interface Data {
  areas: Area[];
  projects: Project[];
  /** What a session type is called: "VO" -> "Lecture". Shared by every course. */
  labels: Record<string, string>;
  /** The offer to bring in the Shortcuts app's spaces was taken or turned down. */
  shortcutsOffered: boolean;
}

/** The common Austrian abbreviations; anything else shows as itself until renamed. */
export const DEFAULT_LABELS: Record<string, string> = {
  VO: "Lecture",
  UE: "Exercise",
  VU: "Lecture & exercise",
  LU: "Lab",
  SE: "Seminar",
  PS: "Proseminar",
  PR: "Project",
  EX: "Exam",
};

/** Colours offered in the editors; any 0..359 in the file is kept. */
export const HUES = [290, 255, 160, 45, 350, 200, 95, 20];

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A fresh store: the three areas the app is shaped around. */
export function starter(): Data {
  return {
    areas: [
      { id: newId(), name: "Uni", hue: 290, rules: [], calendar: "", openDuring: false, shortcuts: [] },
      { id: newId(), name: "Work", hue: 255, rules: [], calendar: "", openDuring: false, shortcuts: [] },
      { id: newId(), name: "Private", hue: 160, rules: [], calendar: "", openDuring: false, shortcuts: [] },
    ],
    projects: [],
    labels: {},
    shortcutsOffered: false,
  };
}

/** What a session type is shown as. */
export const labelOf = (data: Data, type: string): string =>
  data.labels[type] ?? DEFAULT_LABELS[type] ?? (type || "Session");

/**
 * A folder name for a project's notes: its name, made safe to be one path
 * segment, and different from every folder already taken.
 */
export function folderFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 40)
      .trim() || "Project";
  let folder = base;
  for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${base} ${n}`;
  return folder;
}

// ------------------------------------------------------------ validation --

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const idOf = (value: unknown): string =>
  typeof value === "string" && /^[a-z0-9]{1,16}$/i.test(value.trim()) ? value.trim() : "";

/** A calendar's id as the Calendar app keeps it: a subscription's, or "mine:<id>"; "" otherwise. */
const calendarId = (value: unknown): string => {
  const id = text(value, 40);
  return /^(mine:)?[a-z0-9]{1,16}$/i.test(id) ? id : "";
};

const hueOf = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : fallback;

function cleanRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Rule>;
  const days = Array.isArray(given.days)
    ? [...new Set(given.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : [];
  const from = typeof given.from === "string" && TIME.test(given.from) ? given.from : "";
  const to = typeof given.to === "string" && TIME.test(given.to) ? given.to : "";
  return days.length && from && to ? { days, from, to } : null;
}

/** An area icon's link: https only, as os.net fetches nothing else; "" otherwise. */
export function iconOf(value: unknown): string {
  const url = toUrl(text(value, 2000));
  return url?.protocol === "https:" ? url.href : "";
}

function cleanArea(raw: unknown): Area | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Area>;
  const name = text(given.name, MAX_NAME);
  if (!name) return null;
  const rules = (Array.isArray(given.rules) ? given.rules : [])
    .map(cleanRule)
    .filter((rule): rule is Rule => rule !== null)
    .slice(0, MAX_RULES);
  const calendar = calendarId(given.calendar);
  const icon = iconOf(given.icon);
  return {
    id: idOf(given.id) || newId(),
    name,
    hue: hueOf(given.hue, 255),
    ...(icon && { icon }),
    rules,
    calendar,
    openDuring: Boolean(calendar) && given.openDuring === true,
    shortcuts: cleanShortcuts(given.shortcuts),
  };
}

function cleanShortcuts(raw: unknown): Shortcut[] {
  return (Array.isArray(raw) ? raw : [])
    .map(cleanShortcut)
    .filter((shortcut): shortcut is Shortcut => shortcut !== null)
    .slice(0, MAX_SHORTCUTS);
}

function cleanShortcut(raw: unknown): Shortcut | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Shortcut>;
  // The Shortcuts app's own reading: only what openExternal will open survives.
  const url = toUrl(text(given.url, 2000))?.href;
  if (!url) return null;
  return { name: text(given.name, 40) || url, url };
}

function cleanLink(raw: unknown): Link | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const given = raw as Partial<Link>;
  return {
    calendar: calendarId(given.calendar),
    skip: (Array.isArray(given.skip) ? given.skip : [])
      .map((type) => text(type, 12).toUpperCase())
      .filter(Boolean)
      .slice(0, 20),
    open: given.open !== false,
    busy: given.busy !== false,
    end: given.end !== false,
  };
}

function cleanProject(raw: unknown, areas: ReadonlySet<string>): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Partial<Project>;
  const name = text(given.name, MAX_NAME);
  const area = idOf(given.area);
  if (!name || !areas.has(area)) return null;
  const kind = given.kind === "course" ? "course" : "project";
  const folder = text(given.folder, 60);
  return {
    id: idOf(given.id) || newId(),
    area,
    kind,
    name,
    code: kind === "course" ? text(given.code, MAX_CODE) : "",
    hue: hueOf(given.hue, 255),
    shortcuts: cleanShortcuts(given.shortcuts),
    ...(kind === "course" && { link: cleanLink(given.link) ?? cleanLink({})! }),
    ...(typeof given.ended === "boolean" && { ended: given.ended }),
    // One path segment, never "..": it is joined onto the root.
    folder: folder && !/[/\\]/.test(folder) && !/^\.+$/.test(folder) ? folder : "",
  };
}

export function parseData(body: string | null): Data {
  let raw: Partial<Data> = {};
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (parsed && typeof parsed === "object") raw = parsed as Partial<Data>;
  } catch {
    /* no file yet, or not JSON: start empty */
  }
  const areas: Area[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.areas) ? raw.areas : []) {
    const area = cleanArea(entry);
    if (!area) continue;
    while (seen.has(area.id)) area.id = newId();
    seen.add(area.id);
    areas.push(area);
    if (areas.length >= MAX_AREAS) break;
  }

  const areaIds = new Set(areas.map((area) => area.id));
  const projects: Project[] = [];
  const folders = new Set<string>();
  for (const entry of Array.isArray(raw.projects) ? raw.projects : []) {
    const project = cleanProject(entry, areaIds);
    if (!project) continue;
    while (seen.has(project.id)) project.id = newId();
    seen.add(project.id);
    // Two projects in one folder would share their notes: the later one moves.
    if (!project.folder || folders.has(project.folder.toLowerCase())) {
      project.folder = folderFor(project.name, folders);
    }
    folders.add(project.folder.toLowerCase());
    projects.push(project);
    if (projects.length >= MAX_PROJECTS) break;
  }

  const labels: Record<string, string> = {};
  if (raw.labels && typeof raw.labels === "object") {
    for (const [type, label] of Object.entries(raw.labels).slice(0, 40)) {
      const key = text(type, 12).toUpperCase();
      const value = text(label, 30);
      if (key && value) labels[key] = value;
    }
  }
  return { areas, projects, labels, shortcutsOffered: raw.shortcutsOffered === true };
}

export const serialize = (data: Data): string =>
  `${JSON.stringify(
    {
      areas: data.areas,
      projects: data.projects,
      labels: data.labels,
      shortcutsOffered: data.shortcutsOffered,
    },
    null,
    2,
  )}\n`;

// ----------------------------------------------------------------- store --

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? "ERROR";

async function readText(os: AppInterface, path: string): Promise<string | null> {
  try {
    return await os.fs.readTextFile(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

async function mkdir(os: AppInterface, path: string): Promise<void> {
  await os.fs.mkdir(path).catch((error: unknown) => {
    if (codeOf(error) !== "EEXIST") throw error;
  });
}

export interface ProjectStore {
  /** The latest copy this process has seen. Replaced, never mutated in place. */
  readonly data: Data;
  readonly backing: Backing;
  /** The file itself: fs.changed for this path means someone wrote it. */
  readonly path: string;
  /** Where the project folders go. */
  readonly root: string;
  /** Re-read the file. True when it differs from what this process had. */
  reload(): Promise<boolean>;
  /**
   * Apply `change` to the latest copy on disk and write it back, queued
   * behind earlier changes. `data` shows it at once; a failed write rejects
   * and `data` is re-read. `change` runs twice (on screen, then on disk), so
   * it must be deterministic: make ids outside it.
   */
  update(change: (data: Data) => void): Promise<void>;
  /** A project's notes folder, made if it isn't there yet. */
  folderOf(project: Project): Promise<string>;
}

export async function openProjects(os: AppInterface): Promise<ProjectStore> {
  const config = await ensureConfigDir(os);
  const localFile = `${config}/projects.json`;
  const home = config.replace(/\/\.config$/, "");

  let backing: Backing = "local";
  let path = localFile;
  let root = `${home}/Projects`;
  let body: string | null;
  try {
    await mkdir(os, CLOUD_DIR);
    body = await readText(os, CLOUD_FILE);
    // Nothing there yet: start the shared copy from what this browser has.
    if (body === null) {
      const seed = await os.fs.readTextFile(localFile).catch(() => null);
      body = serialize(seed === null ? starter() : parseData(seed));
      await os.fs.writeTextFile(CLOUD_FILE, body);
    }
    backing = "cloud";
    path = CLOUD_FILE;
    root = CLOUD_DIR;
  } catch {
    // No server, or not ours: this browser keeps its own.
    body = await os.fs.readTextFile(localFile).catch(() => null);
    if (body === null) {
      body = serialize(starter());
      await os.fs.writeTextFile(localFile, body).catch(() => {});
    }
  }

  let data = parseData(body);
  let known = serialize(data);
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

  const read = async (): Promise<Data> => parseData(await readText(os, path));

  return {
    get data() {
      return data;
    },
    backing,
    path,
    root,
    async reload(): Promise<boolean> {
      await queue.catch(() => {});
      const next = await read().catch(() => null);
      if (!next || pending) return false;
      const after = serialize(next);
      if (after === known) return false;
      data = next;
      known = after;
      return true;
    },
    update(change): Promise<void> {
      const before = data;
      const optimistic = structuredClone(data);
      change(optimistic);
      data = parseData(serialize(optimistic));

      pending++;
      const run = async (): Promise<void> => {
        try {
          const latest = await read();
          const was = serialize(latest);
          change(latest);
          const next = parseData(serialize(latest));
          const out = serialize(next);
          if (out !== was) await os.fs.writeTextFile(path, out);
          known = out;
          if (pending === 1) data = next;
        } catch (error) {
          data = await read().catch(() => before);
          known = serialize(data);
          throw error;
        } finally {
          pending--;
        }
      };
      const done = queue.then(run, run);
      queue = done.catch(() => {});
      return done;
    },
    async folderOf(project): Promise<string> {
      await mkdir(os, root);
      const dir = `${root}/${project.folder}`;
      await mkdir(os, dir);
      return dir;
    },
  };
}

/** The sentence a failed save shows. Only the cloud's own wording names it. */
export function saveProblem(error: unknown, backing: Backing): string {
  if (codeOf(error) === "ENOSPC") {
    return backing === "cloud" ? "There's no room left in cloud storage." : "There's no room left.";
  }
  if (backing === "cloud" && codeOf(error) === "EACCES") return "Signed out — couldn't save.";
  return "Couldn't save. Try again.";
}

// ------------------------------------------------------ from Shortcuts --

interface ShortcutsFile {
  spaces?: {
    name?: unknown;
    rules?: unknown;
    projects?: { id?: unknown; name?: unknown }[];
    shortcuts?: { name?: unknown; url?: unknown; project?: unknown }[];
  }[];
}

/**
 * The Shortcuts app's spaces as areas, each of its projects as a project
 * with its sites, and a space's loose sites as a project named after the
 * space. Ids are made here, outside any store change, so the change that
 * adds them is deterministic.
 */
export function fromShortcuts(body: string, taken: ReadonlySet<string>): { areas: Area[]; projects: Project[] } {
  let raw: ShortcutsFile;
  try {
    raw = JSON.parse(body) as ShortcutsFile;
  } catch {
    return { areas: [], projects: [] };
  }
  const areas: Area[] = [];
  const projects: Project[] = [];
  const folders = new Set(taken);
  const add = (area: Area, name: string, sites: Shortcut[]): void => {
    const folder = folderFor(name, folders);
    folders.add(folder.toLowerCase());
    projects.push({
      id: newId(),
      area: area.id,
      kind: "project",
      name,
      code: "",
      hue: area.hue,
      shortcuts: sites.slice(0, MAX_SHORTCUTS),
      folder,
    });
  };
  for (const [index, space] of (Array.isArray(raw.spaces) ? raw.spaces : []).entries()) {
    const area = cleanArea({ name: space.name, rules: space.rules, hue: HUES[index % HUES.length] });
    if (!area) continue;
    areas.push(area);
    const sites = (Array.isArray(space.shortcuts) ? space.shortcuts : []).map((site) => ({
      site: cleanShortcut(site),
      project: typeof site?.project === "string" ? site.project : "",
    }));
    for (const project of Array.isArray(space.projects) ? space.projects : []) {
      const name = text(project?.name, MAX_NAME);
      if (!name) continue;
      add(
        area,
        name,
        sites.filter((each) => each.site && each.project === project.id).map((each) => each.site!),
      );
    }
    const loose = sites.filter((each) => each.site && !space.projects?.some((p) => p.id === each.project));
    if (loose.length) add(area, area.name, loose.map((each) => each.site!));
  }
  return { areas: areas.slice(0, MAX_AREAS), projects };
}

// -------------------------------------------------------- for the Calendar --

/** The files readProjectHues looks at, in order: what fs.changed should watch. */
export const projectFiles = (home: string): string[] => [CLOUD_FILE, `${home}/.config/projects.json`];

/**
 * Each project's and area's colour, by id, for the Calendar to draw their
 * todos in (ids never repeat across the two: parseData sees to it). Read
 * only -- the cloud copy if the mount lets us read it, else this browser's --
 * and never made or written: opening the Calendar mustn't start a Projects store.
 */
export async function readProjectHues(os: AppInterface): Promise<Map<string, number>> {
  const home = (await os.process.env()).HOME ?? "/";
  for (const path of projectFiles(home)) {
    const body = await os.fs.readTextFile(path).catch(() => null);
    if (body === null) continue;
    const data = parseData(body);
    return new Map([...data.areas, ...data.projects].map((each) => [each.id, each.hue]));
  }
  return new Map();
}
