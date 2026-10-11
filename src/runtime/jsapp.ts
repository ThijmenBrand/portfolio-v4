import { KernelError } from "../kernel/errors";
import type { AppInterface } from "../kernel/syscalls/api";
import * as kit from "../ui/kit";
import { formatManifest, parseManifest, type AppFileManifest } from "../utils/appfile";
import { followAccent } from "../utils/settings";
import { loadProgram } from "./jsload";

/**
 * `#!/ProgramFiles/jsapp`: run a JS file from the VFS as a GUI app, in this
 * sandboxed iframe (user-app-host). args[0] is the script, the rest are its
 * arguments. The program claims its window with `os.windows.create`, which
 * gets the manifest's (//@app) title and size as defaults.
 */
export async function main(os: AppInterface, args: string[]): Promise<void> {
  const [path, ...rest] = args;
  if (!path) throw new KernelError("EINVAL", "usage: jsapp <file.js> [args...]");
  await followAccent(os);

  const manifest =
    parseManifest(await os.fs.readTextFile(path)) ?? (await appJson(os, path));
  const defaults = {
    ...manifest?.window,
    title: manifest?.window?.title ?? manifest?.name ?? basename(path),
  };
  let window: Awaited<ReturnType<AppInterface["windows"]["create"]>> | undefined;
  const userOs: AppInterface = {
    ...os,
    windows: {
      ...os.windows,
      create: async (options) => (window = await os.windows.create({ ...defaults, ...options })),
    },
  };

  try {
    const program = await loadProgram((p) => os.fs.readTextFile(p), path, {
      "os:ui": kitModule(),
    });
    await program.main(userOs, rest);
  } catch (error) {
    await showError(os, path, error, window);
  }
}

/**
 * A program that fails to load or throws from main: say why, in its window
 * and on stderr (the terminal it was started from), instead of vanishing.
 * The window stays until closed.
 */
async function showError(
  os: AppInterface,
  path: string,
  error: unknown,
  window: Awaited<ReturnType<AppInterface["windows"]["create"]>> | undefined,
): Promise<void> {
  const text = error instanceof Error ? error.message : String(error);
  await os.io.write(2, new TextEncoder().encode(`jsapp: ${path}: ${text}\n`)).catch(() => {});

  const win = window ?? (await os.windows.create({ title: basename(path) }));
  void win.setTitle(`${basename(path)} — error`);
  void win.onCloseRequest(() => void os.process.exit(1));
  kit.mount(
    kit.h("h2", null, `${basename(path)} crashed`),
    kit.h("pre", { style: { whiteSpace: "pre-wrap", color: "var(--app-danger)" } }, text),
    kit.h("p", { class: "muted" }, "Fix it and run it again. Imports are relative to the file: ./name.js"),
  );
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Unbundled, an app.json next to the entry is its manifest (bundle inlines it). */
async function appJson(os: AppInterface, path: string): Promise<AppFileManifest | null> {
  try {
    const raw = JSON.parse(await os.fs.readTextFile(`${path.slice(0, path.lastIndexOf("/"))}/app.json`));
    return parseManifest(formatManifest({ ...raw, icon: undefined }));
  } catch {
    return null;
  }
}

/** `os:ui` as a module URL: re-exports src/ui/kit.ts, bundled with us. */
function kitModule(): string {
  (globalThis as { __osui?: unknown }).__osui = kit;
  const code =
    "const kit = globalThis.__osui;\n" +
    Object.keys(kit)
      .map((name) => `export const ${name} = kit.${name};`)
      .join("\n");
  return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
}
