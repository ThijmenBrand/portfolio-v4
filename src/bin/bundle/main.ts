// bundle — pack a JS app (entry + everything it imports) into one .app.js file.
import type { AppInterface } from "../../kernel/syscalls/api";
import { basename, dirname, join, resolveFrom } from "../../kernel/fs/path";
import { BUNDLE_PREFIX, collect, type Bundle } from "../../runtime/jsload";
import {
  formatManifest,
  parseManifest,
  USER_APPS_DIR,
  type AppFileManifest,
} from "../../utils/appfile";
import { extOf, IMAGE_TYPES } from "../../utils/filetypes";
import { errorCode, print } from "../lib/input";

const USAGE = `usage: bundle <entry.js> [-o out.app.js] [--name NAME] [--icon FILE] [--install]

Packs <entry.js> and every module it imports (from its folder) into one
file that runs on its own: double-click it, download it, upload it anywhere.
Name, icon, version and window size come from app.json next to the entry:
  {"name": "Hello", "icon": "icon.svg", "version": "1.0", "window": {"width": 480, "height": 320}}
Spotlight (Cmd+K) commands too, run by the "handler" module's command(os, id, input):
  "commands": [{"id": "new", "title": "New note", "input": {"placeholder": "Note"}}],
  "handler": "commands.js"
--install also copies it to ~/${USER_APPS_DIR}, so it shows in the app menu.
`;

interface Options {
  entry?: string;
  out?: string;
  name?: string;
  icon?: string;
  install: boolean;
}

function parseArgs(args: string[]): Options | null {
  const options: Options = { install: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = () => args[++i];
    if (arg === "-o") options.out = value();
    else if (arg === "--name") options.name = value();
    else if (arg === "--icon") options.icon = value();
    else if (arg === "--install") options.install = true;
    else if (arg.startsWith("-") || options.entry) return null;
    else options.entry = arg;
  }
  return options.entry ? options : null;
}

export async function main(os: AppInterface, args: string[]): Promise<void> {
  const options = parseArgs(args);
  if (!options) {
    await print(os, 2, USAGE);
    return void (await os.process.exit(2));
  }
  try {
    const out = await bundle(os, options);
    await print(os, 1, `${out}\n`);
    await os.process.exit(0);
  } catch (error) {
    await print(os, 2, `bundle: ${(error as Error).message ?? errorCode(error)}\n`);
    await os.process.exit(1);
  }
}

async function bundle(os: AppInterface, options: Options): Promise<string> {
  const cwd = await os.process.cwd();
  const entry = resolveFrom(cwd, options.entry!);
  const root = dirname(entry);

  const manifest = await manifestFor(os, root, options);

  // ponytail: absolute imports (/home/…) inside the app aren't remapped; use ./ ones.
  const read = (path: string) => os.fs.readTextFile(path);
  const graph = await collect(read, entry);
  // The Spotlight command handler (app.json "handler") and what it imports come along too.
  if (manifest.handler) {
    for (const [path, source] of await collect(read, join(`${root}/${manifest.handler}`))) {
      graph.set(path, source);
    }
  }
  const modules: Record<string, string> = {};
  for (const [path, source] of graph) {
    if (!path.startsWith(`${root}/`)) {
      throw new Error(`${path} is outside ${root}; keep the whole app in one folder`);
    }
    modules[path.slice(root.length + 1)] = source;
  }

  const source = graph.get(entry)!;
  const shebang = source.startsWith("#!") ? source.split("\n", 1)[0]! : "#!/ProgramFiles/jsapp";
  const data: Bundle = { v: 1, entry: basename(entry), modules };
  const text = `${shebang}\n${formatManifest(manifest)}\n${BUNDLE_PREFIX}${JSON.stringify(data)};\n`;

  const fileName = `${slug(manifest.name ?? basename(root))}.app.js`;
  const out = resolveFrom(cwd, options.out ?? fileName);
  await os.fs.writeTextFile(out, text);

  const size = `${Object.keys(modules).length} modules, ${Math.ceil(text.length / 1024)} KB`;
  if (!options.install) return `${out} (${size})`;

  const dir = `${(await os.process.env()).HOME ?? "/"}/${USER_APPS_DIR}`;
  await mkdirs(os, dir);
  await os.fs.writeTextFile(`${dir}/${basename(out)}`, text);
  return `${out} (${size}), installed to ${dir}/${basename(out)}`;
}

/** app.json (if any), then --name / --icon on top; the icon inlined as a data: URL. */
async function manifestFor(os: AppInterface, root: string, options: Options): Promise<AppFileManifest> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await os.fs.readTextFile(`${root}/app.json`));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw new Error(`${root}/app.json: ${(error as Error).message}`);
  }
  const iconPath = options.icon ?? (typeof raw.icon === "string" ? raw.icon : undefined);
  const wanted = {
    ...raw,
    name: options.name ?? raw.name,
    icon: iconPath ? await dataUrl(os, resolveFrom(root, iconPath)) : undefined,
  };
  // Same checks every reader applies, so a bad field fails here, loudly.
  const manifest = parseManifest(formatManifest(wanted as AppFileManifest)) ?? {};
  if (iconPath && !manifest.icon) {
    throw new Error(`${iconPath}: icon must be an svg/png/webp/gif/jpeg image under 48 KB`);
  }
  return manifest;
}

async function dataUrl(os: AppInterface, path: string): Promise<string> {
  const type = IMAGE_TYPES[extOf(path)];
  if (!type) throw new Error(`${path}: not an image`);
  const bytes = await os.fs.readFile(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${type};base64,${btoa(binary)}`;
}

async function mkdirs(os: AppInterface, path: string): Promise<void> {
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at = join(`${at}/${part}`);
    await os.fs.mkdir(at).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
  }
}

const slug = (name: string) =>
  name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
