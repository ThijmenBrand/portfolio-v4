/**
 * The manifest of a user program: a `//@app {json}` comment in its first few
 * lines (line 2 of a `bundle` output, under the #!). Read as data, so Files,
 * the desktop and the launcher can show an app's name and icon without running
 * it. Everything in it is untrusted: validated here, and the icon is only
 * ever used as an <img src>.
 */
export interface AppFileManifest {
  name?: string;
  /** data:image/(svg+xml|png|webp|gif|jpeg) URL. */
  icon?: string;
  version?: string;
  window?: { title?: string; width?: number; height?: number };
}

const PREFIX = "//@app ";
const MAX_ICON = 64 * 1024;
const ICON = /^data:image\/(?:svg\+xml|png|webp|gif|jpeg)(?:;base64)?,/;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

const size = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : undefined;

/** The manifest in `source`, cleaned up; null when there is none or it's broken. */
export function parseManifest(source: string): AppFileManifest | null {
  const line = source.split("\n", 5).find((l) => l.startsWith(PREFIX));
  if (!line) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const manifest: AppFileManifest = {};
  const name = text(raw.name, 64);
  if (name) manifest.name = name;
  const version = text(raw.version, 32);
  if (version) manifest.version = version;
  if (typeof raw.icon === "string" && raw.icon.length <= MAX_ICON && ICON.test(raw.icon)) {
    manifest.icon = raw.icon;
  }
  const win = raw.window as Record<string, unknown> | undefined;
  if (typeof win === "object" && win !== null) {
    manifest.window = {
      title: text(win.title, 128),
      width: size(win.width, 160, 1920),
      height: size(win.height, 120, 1080),
    };
  }
  return manifest;
}

/** The manifest line `bundle` writes. */
export function formatManifest(manifest: AppFileManifest): string {
  return PREFIX + JSON.stringify(manifest);
}

/** Read just the head of `path` (a manifest sits in its first lines). */
export async function readManifest(
  readFile: (path: string) => Promise<Uint8Array>,
  path: string,
): Promise<AppFileManifest | null> {
  try {
    const bytes = await readFile(path);
    // ponytail: reads the whole file; os.io.open + read(n) if apps get big.
    return parseManifest(new TextDecoder().decode(bytes.subarray(0, MAX_ICON + 4096)));
  } catch {
    return null;
  }
}

/** Where installed user apps live (`bundle --install`), under $HOME. */
export const USER_APPS_DIR = ".local/share/apps";

/** A `.app.js` file: a one-file app written by `bundle`. */
export const isAppFile = (path: string): boolean => path.endsWith(".app.js");
