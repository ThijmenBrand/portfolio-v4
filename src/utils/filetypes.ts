import type { AppInterface } from "../kernel/syscalls/api";

/** Lowercase extension of a name or path ("" when there is none). */
export const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const CODE = "/ProgramFiles/code";
const PREVIEW = "/ProgramFiles/preview";

/** Apps that open a file passed as their first argument; the choices in Settings. */
export const FILE_APPS = [CODE, PREVIEW];

/** Extension -> built-in default app. Anything unlisted opens in Code. */
const DEFAULT_APPS: Record<string, string> = Object.fromEntries(
  Object.keys(IMAGE_TYPES).map((ext) => [ext, PREVIEW]),
);

/** Extensions Settings lets the user pick a default app for, by section. */
export const FILE_TYPES: Record<string, string[]> = {
  Documents: ["txt", "md", "pdf"],
  Code: ["json", "html", "css", "js", "ts", "py", "sh"],
  Images: Object.keys(IMAGE_TYPES),
};

/** `overrides` is settings.openWith: the user's extension -> app picks. */
export const defaultAppFor = (path: string, overrides: Record<string, string> = {}): string =>
  overrides[extOf(path)] ?? DEFAULT_APPS[extOf(path)] ?? CODE;

/** A `.app` file is a shortcut, like a Linux .desktop file: its text is the program to run. */
export async function readShortcut(os: AppInterface, path: string): Promise<string | null> {
  if (extOf(path) !== "app") return null;
  return (await os.fs.readTextFile(path).catch(() => "")).trim() || null;
}

/** The shortcuts in `dir` that run `exec`. */
export async function shortcutsTo(os: AppInterface, dir: string, exec: string): Promise<string[]> {
  const paths = (await os.fs.readdir(dir).catch(() => [])).map((entry) => `${dir}/${entry.name}`);
  const targets = await Promise.all(paths.map((path) => readShortcut(os, path)));
  return paths.filter((_, i) => targets[i] === exec);
}

export const FOLDER_SVG =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path class="folder-back" d="M6 13a3 3 0 0 1 3-3h10l4 4h16a3 3 0 0 1 3 3v3H6z" /><path class="folder-front" d="M6 18h36v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" /></svg>';
export const FILE_SVG =
  '<svg viewBox="0 0 48 48" aria-hidden="true"><path class="page" d="M12 5h17l9 9v27a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /><path class="page-fold" d="M29 5v7a2 2 0 0 0 2 2h7" /></svg>';
