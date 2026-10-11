import { KernelError } from "../kernel/errors";
import { dirname, join } from "../kernel/fs/path";

/**
 * Loads JS programs from the VFS: the module graph under an entry file,
 * linked into blob: URLs and imported. Used by the interpreters
 * (`#!/ProgramFiles/jsapp`, `#!/ProgramFiles/node`) in the user-* realm hosts,
 * whose CSP allows blob: scripts, and by `bundle`, which only collects.
 *
 * Imports: relative (`./x.js`, `../y.js`), absolute (`/home/me/z.js`), `.json`
 * (default export), `.html` (a string), `.css` (injected as <style>, GUI only) and the built-in
 * `os:*` specifiers (see `builtins`). No bare specifiers (npm).
 *
 * ponytail: regex import rewrite; also matches imports inside strings and
 * comments, and misses dynamic import(). Swap for es-module-lexer if it bites.
 */

/** Reads one module's source by absolute path. */
export type Read = (path: string) => Promise<string>;

/** Module path -> source, dependencies before dependents. */
export type Graph = Map<string, string>;

/** `import … from "x"`, `import "x"`, `export … from "x"`. Group 3 is x. */
const SPECIFIER =
  /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)(["'])([^"'\n]+)\2/g;

const isBuiltin = (spec: string) => spec.startsWith("os:");

function resolveSpec(from: string, spec: string): string {
  if (isBuiltin(spec)) return spec;
  if (spec.startsWith("/")) return join(spec);
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return join(dirname(from), spec);
  }
  throw new KernelError(
    "ENOENT",
    `${from}: can't import "${spec}" (only ./relative, /absolute and os: imports)`,
  );
}

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[3]!);
}

/**
 * Every module reachable from `entry`, deps first. An import cycle is an
 * error: a blob: URL needs its deps' URLs before it exists, so they can't
 * point at each other. ponytail: no cycles; bundle-style hoisting if needed.
 */
export async function collect(read: Read, entry: string): Promise<Graph> {
  const graph: Graph = new Map();
  const stack: string[] = [];

  const visit = async (path: string): Promise<void> => {
    if (graph.has(path)) return;
    if (stack.includes(path)) {
      throw new KernelError(
        "ELOOP",
        `import cycle: ${[...stack.slice(stack.indexOf(path)), path].join(" -> ")}`,
      );
    }
    stack.push(path);
    const source = await read(path);
    if (isScript(path)) {
      for (const spec of specifiers(source)) {
        const dep = resolveSpec(path, spec);
        if (!isBuiltin(dep)) await visit(dep);
      }
    }
    stack.pop();
    graph.set(path, source);
  };

  await visit(join(entry));
  return graph;
}

const isScript = (path: string) => !/\.(json|css|html)$/i.test(path);

/**
 * A non-JS module turned into JS: JSON as its default export, HTML as a
 * string (mount it with `html()` from os:ui), CSS as a <style>.
 */
function asModule(path: string, source: string): string {
  if (/\.html$/i.test(path)) return `export default ${JSON.stringify(source)};`;
  if (/\.json$/i.test(path)) {
    try {
      return `export default ${JSON.stringify(JSON.parse(source))};`;
    } catch (error) {
      throw new KernelError("EINVAL", `${path}: ${(error as Error).message}`);
    }
  }
  if (/\.css$/i.test(path)) {
    return `if (typeof document === "undefined") throw new Error(${JSON.stringify(
      `${path}: CSS needs a window (run it with #!/ProgramFiles/jsapp)`,
    )});
const style = document.createElement("style");
style.dataset.src = ${JSON.stringify(path)};
style.textContent = ${JSON.stringify(source)};
document.head.append(style);`;
  }
  return source;
}

const blobUrl = (code: string) =>
  URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

/**
 * Turn a graph into blob: URLs, deps first, rewriting each import to the URL
 * of what it names. `builtins` maps `os:*` specifiers to module URLs.
 * Returns the URL of `entry`.
 */
export function link(
  graph: Graph,
  entry: string,
  builtins: Record<string, string> = {},
): string {
  const urls = new Map<string, string>();
  for (const [path, source] of graph) {
    const code = isScript(path)
      ? source.replace(SPECIFIER, (_match, head: string, quote: string, spec: string) => {
          const dep = resolveSpec(path, spec);
          const url = isBuiltin(dep) ? builtins[dep] : urls.get(dep);
          if (!url) throw new KernelError("ENOENT", `${path}: no module "${spec}"`);
          return `${head}${quote}${url}${quote}`;
        })
      : asModule(path, source);
    // Errors and stack traces name the VFS file, not the blob.
    urls.set(path, blobUrl(`${code}\n//# sourceURL=${encodeURI(path)}`));
  }
  return urls.get(join(entry))!;
}

/**
 * A one-file app (written by `bundle`): line 3 is `export const bundle = <JSON>;`.
 * Read as data, never run: its embedded sources hold import statements of
 * their own, which the rewrite must not touch.
 */
export interface Bundle {
  v: 1;
  entry: string;
  modules: Record<string, string>;
}

export const BUNDLE_PREFIX = "export const bundle = ";

export function parseBundle(source: string): Bundle | null {
  const line = source.split("\n", 4).find((l) => l.startsWith(BUNDLE_PREFIX));
  if (!line) return null;
  try {
    const bundle = JSON.parse(line.slice(BUNDLE_PREFIX.length).replace(/;\s*$/, "")) as Bundle;
    if (bundle?.v !== 1 || typeof bundle.entry !== "string" || typeof bundle.modules !== "object") {
      return null;
    }
    return bundle;
  } catch {
    return null;
  }
}

/** A loaded program: what both interpreters call `main` on. */
export interface Program {
  main(os: unknown, args: string[]): unknown;
}

/**
 * Load `path` (a plain module or a bundle) and import it. Bundle modules
 * live under "/" in a graph of their own; nothing else is read from the VFS.
 */
export async function loadProgram(
  readFs: Read,
  path: string,
  builtins: Record<string, string> = {},
): Promise<Program> {
  const source = await readFs(path);
  const bundle = parseBundle(source);
  const read: Read = bundle
    ? async (p) => {
        const text = bundle.modules[p.slice(1)];
        if (text === undefined) throw new KernelError("ENOENT", `${path}: bundle has no ${p}`);
        return text;
      }
    : async (p) => (p === path ? source : readFs(p));
  const entry = bundle ? join("/", bundle.entry) : path;

  const graph = await collect(read, entry);
  const module = (await import(/* @vite-ignore */ link(graph, entry, builtins))) as Partial<Program>;
  if (typeof module.main !== "function") {
    throw new KernelError("ENOEXEC", `${path}: no exported main(os, args)`);
  }
  return module as Program;
}

/**
 * Point the realm's console at the program's stdio: log/info/debug to fd 1,
 * warn/error to fd 2, so they land in the terminal it was started from
 * (and in /proc/<pid>/log, which is all a desktop-launched app has).
 * The realm (worker or iframe) is this program's alone, so patching is safe. Returns a flush: await it before exiting.
 */
export function pipeConsole(os: { io: { write(fd: number, data: Uint8Array): Promise<unknown> } }): () => Promise<void> {
  const encoder = new TextEncoder();
  let queue = Promise.resolve(); // keep lines in call order
  const show = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value); // cyclic
    }
  };
  const pipe = (fd: number) => (...args: unknown[]) => {
    const line = encoder.encode(args.map(show).join(" ") + "\n");
    queue = queue.then(() => os.io.write(fd, line)).then(() => {}, () => {});
  };
  Object.assign(console, {
    log: pipe(1),
    info: pipe(1),
    debug: pipe(1),
    warn: pipe(2),
    error: pipe(2),
  });
  return () => queue;
}
