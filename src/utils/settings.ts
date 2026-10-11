// Per-user preferences in ~/.config/settings.json, next to ~/.config/autostart.
// Written by the Settings app; the desktop, taskbar and apps re-read it on SIGHUP.
import type { AppInterface } from "../kernel/syscalls/api";

const photo = (file: string): string => `url(/assets/wallpapers/${file}) center / cover, #111`;

export const WALLPAPERS: Record<string, string> = {
  forest: `radial-gradient(120% 90% at 20% 0%, #2b5c4c 0%, transparent 60%),
    radial-gradient(100% 80% at 100% 100%, #1d3550 0%, transparent 55%),
    linear-gradient(160deg, #16241f 0%, #0c1418 100%)`,
  ocean: `radial-gradient(120% 90% at 80% 0%, #24507a 0%, transparent 60%),
    linear-gradient(160deg, #102033 0%, #080f18 100%)`,
  dusk: `radial-gradient(120% 90% at 20% 0%, #5c2b4f 0%, transparent 60%),
    radial-gradient(100% 80% at 100% 100%, #50361d 0%, transparent 55%),
    linear-gradient(160deg, #24161f 0%, #140c10 100%)`,
  graphite: "linear-gradient(160deg, #26262b 0%, #121214 100%)",
  valley: photo("valley.jpg"),
  mountains: photo("mountains.jpg"),
  highlands: photo("highlands.jpg"),
  coast: photo("coast.jpg"),
};

/** settings.wallpaper value for the image the user uploaded to ~/.config/wallpaper. */
export const CUSTOM_WALLPAPER = "custom";

/** Preset profile pictures: an emoji on the account's usual colored circle. */
export const AVATARS: Record<string, string> = {
  fox: "🦊",
  cat: "🐱",
  owl: "🦉",
  panda: "🐼",
  frog: "🐸",
  octopus: "🐙",
  rocket: "🚀",
  cactus: "🌵",
};

/** settings.avatar value for the image the user uploaded to ~/.config/avatar. */
export const CUSTOM_AVATAR = "custom";

export const ACCENTS: Record<string, string> = {
  blue: "#5a9cff",
  teal: "#3cc4c0",
  green: "#6cd39a",
  amber: "#e2b95f",
  pink: "#f27ab6",
  violet: "#a58bff",
};

export const ICON_SCALES = { small: 0.8, medium: 1, large: 1.25 } as const;

export interface Settings {
  wallpaper: string;
  accent: string;
  clock24h: boolean;
  clockSeconds: boolean;
  dateFormat: "weekday" | "date" | "none";
  iconSize: keyof typeof ICON_SCALES;
  /** Minimized windows fly into their taskbar button instead of vanishing. */
  animateMinimize: boolean;
  /** "" shows the name's initial; else an AVATARS key or CUSTOM_AVATAR. */
  avatar: string;
  /** Extension -> program path, overriding filetypes' built-in default app. */
  openWith: Record<string, string>;
}

export const DEFAULTS: Settings = {
  wallpaper: "forest",
  accent: "blue",
  clock24h: true,
  clockSeconds: false,
  dateFormat: "weekday",
  iconSize: "medium",
  animateMinimize: true,
  avatar: "",
  openWith: {},
};

/** Point --app-accent (theme.css) at the chosen accent, in this document. */
export function applyAccent(settings: Settings, doc: Document = document): void {
  const color = ACCENTS[settings.accent] ?? ACCENTS.blue;
  doc.documentElement.style.setProperty("--app-accent", color);
  doc.documentElement.style.setProperty("--app-accent-soft", `color-mix(in srgb, ${color} 16%, transparent)`);
}

/** Apply the accent now and again whenever the Settings app sends SIGHUP. */
export async function followAccent(os: AppInterface): Promise<void> {
  applyAccent(await loadSettings(os));
  await os.process.onSignal("SIGHUP", () => void loadSettings(os).then((s) => applyAccent(s)));
}

/** The topbar clock's format; the Settings app previews with the same one. */
export function clockFormat(settings: Settings): Intl.DateTimeFormat {
  const date = settings.dateFormat !== "none";
  return new Intl.DateTimeFormat(undefined, {
    weekday: settings.dateFormat === "weekday" ? "short" : undefined,
    day: date ? "numeric" : undefined,
    month: date ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: settings.clockSeconds ? "2-digit" : undefined,
    hour12: !settings.clock24h,
  });
}

let customURL: string | undefined;

/** CSS background for the chosen wallpaper; reads the uploaded one into a blob URL. */
export async function wallpaperCSS(os: AppInterface, settings: Settings): Promise<string> {
  if (settings.wallpaper !== CUSTOM_WALLPAPER) return WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[DEFAULTS.wallpaper];
  try {
    const bytes = await os.fs.readFile(`${await configDir(os)}/wallpaper`);
    if (customURL) URL.revokeObjectURL(customURL);
    customURL = URL.createObjectURL(new Blob([bytes]));
    return `url("${customURL}") center / cover, #111`;
  } catch {
    return WALLPAPERS[DEFAULTS.wallpaper];
  }
}

export async function hasCustomWallpaper(os: AppInterface): Promise<boolean> {
  return os.fs.stat(`${await configDir(os)}/wallpaper`).then(() => true, () => false);
}

/** Store an uploaded image as ~/.config/wallpaper, replacing the previous one. */
export async function saveCustomWallpaper(os: AppInterface, file: File): Promise<void> {
  const dir = await ensureConfigDir(os);
  await os.fs.writeFile(`${dir}/wallpaper`, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Paints `home`'s chosen picture over `el` (which already shows the initial).
 * Takes the home folder so the login screen, running as root, can paint every user.
 */
export async function paintAvatar(os: AppInterface, el: HTMLElement, home?: string): Promise<void> {
  const { avatar } = await loadSettings(os, home);
  if (avatar === CUSTOM_AVATAR) {
    const bytes = await os.fs.readFile(`${await configDir(os, home)}/avatar`).catch(() => undefined);
    if (!bytes) return;
    // ponytail: blob URL never revoked, one per paint; fine for a handful of avatars
    el.style.background = `url("${URL.createObjectURL(new Blob([bytes]))}") center / cover`;
    el.textContent = "";
  } else if (AVATARS[avatar]) {
    el.textContent = AVATARS[avatar];
  }
}

export async function hasCustomAvatar(os: AppInterface): Promise<boolean> {
  return os.fs.stat(`${await configDir(os)}/avatar`).then(() => true, () => false);
}

/** Store an uploaded image as ~/.config/avatar, replacing the previous one. */
export async function saveCustomAvatar(os: AppInterface, file: File): Promise<void> {
  const dir = await ensureConfigDir(os);
  await os.fs.writeFile(`${dir}/avatar`, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Program lists in ~/.config, one path per line, each owned by one process:
 * autostart (started by the desktop at login), desktop (seeds a new ~/Desktop) and
 * taskbar (pinned apps). The value here stands in until the user saves their own.
 */
export const PATH_LISTS = {
  /** The resume, the first thing a visitor sees. */
  autostart: "/ProgramFiles/resume\n",
  desktop: ["resume", "files", "terminal", "code", "settings"].map((id) => `/ProgramFiles/${id}\n`).join(""),
  taskbar: "/ProgramFiles/files\n",
} as const;

export type PathList = keyof typeof PATH_LISTS;

export async function loadPathList(os: AppInterface, name: PathList): Promise<string[]> {
  const text = await os.fs.readTextFile(`${await configDir(os)}/${name}`).catch(() => PATH_LISTS[name]);
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

/** Add or remove one program, leaving comments and other entries as they are. */
export async function setInPathList(os: AppInterface, name: PathList, path: string, enabled: boolean): Promise<void> {
  const file = `${await ensureConfigDir(os)}/${name}`;
  const lines = (await os.fs.readTextFile(file).catch(() => PATH_LISTS[name]))
    .split("\n")
    .filter((line) => line.trim() && line.trim() !== path);
  if (enabled) lines.push(path);
  await os.fs.writeTextFile(file, lines.map((line) => line + "\n").join(""));
}

export const loadAutostart = (os: AppInterface): Promise<string[]> => loadPathList(os, "autostart");
export const setAutostart = (os: AppInterface, path: string, enabled: boolean): Promise<void> =>
  setInPathList(os, "autostart", path, enabled);

/** Desktop icon cells by file name in ~/Desktop, saved by the desktop after the user moves icons. */
export type IconLayout = Record<string, { column: number; row: number }>;

export async function loadIconLayout(os: AppInterface): Promise<IconLayout> {
  const text = await os.fs.readTextFile(`${await configDir(os)}/desktop-layout.json`).catch(() => "{}");
  try {
    return JSON.parse(text) as IconLayout;
  } catch {
    return {};
  }
}

export async function saveIconLayout(os: AppInterface, layout: IconLayout): Promise<void> {
  const dir = await ensureConfigDir(os);
  await os.fs.writeTextFile(`${dir}/desktop-layout.json`, JSON.stringify(layout, null, 2) + "\n");
}

export async function ensureConfigDir(os: AppInterface): Promise<string> {
  const dir = await configDir(os);
  await os.fs.mkdir(dir).catch((error) => {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  });
  return dir;
}

async function configDir(os: AppInterface, home?: string): Promise<string> {
  return `${home ?? (await os.process.env()).HOME ?? "/"}/.config`;
}

/** This user's settings, or with `home` another user's (root only, for the login screen). */
export async function loadSettings(os: AppInterface, home?: string): Promise<Settings> {
  try {
    const text = await os.fs.readTextFile(`${await configDir(os, home)}/settings.json`);
    // ponytail: merge over defaults, no per-field validation
    return { ...DEFAULTS, ...(JSON.parse(text) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(os: AppInterface, settings: Settings): Promise<void> {
  const dir = await ensureConfigDir(os);
  await os.fs.writeTextFile(`${dir}/settings.json`, JSON.stringify(settings, null, 2) + "\n");
}
