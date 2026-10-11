// tar — pack directories into one file and back. ustar, optionally gzipped
// with the browser's own CompressionStream. See `man tar`.
import type { AppInterface } from "../../kernel/syscalls/api";
import { errorCode, print } from "../lib/input";
import { type Entry, isGzip, pack, unpack } from "../lib/ustar";
import { mkdirP } from "../mkdir/main";

const USAGE = "usage: tar -c|-x|-t [-z] [-v] -f archive [path...]   (man tar)\n";

export async function main(os: AppInterface, args: string[]): Promise<void> {
  // Bundled flags (-czvf x) and separate ones (-c -z -f x) both work.
  let mode = "";
  let gzip = false;
  let verbose = false;
  let file: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") {
      paths.push(a);
      continue;
    }
    for (const flag of a.slice(1)) {
      if ("cxt".includes(flag)) mode += flag;
      else if (flag === "z") gzip = true;
      else if (flag === "v") verbose = true;
      else if (flag === "f") file = args[++i];
      else mode = "?";
    }
  }
  if (mode.length !== 1 || mode === "?" || !file || (mode === "c" && paths.length === 0)) {
    await print(os, 2, USAGE);
    return os.process.exit(2);
  }

  try {
    if (mode === "c") {
      const entries: Entry[] = [];
      for (const path of paths) await collect(os, path, entries);
      if (verbose) for (const e of entries) await print(os, 2, `${e.path}\n`);
      let archive = pack(entries);
      if (gzip) archive = await transform(archive, new CompressionStream("gzip"));
      if (file === "-") await os.io.write(1, archive);
      else await os.fs.writeFile(file, archive);
    } else {
      let archive = file === "-" ? await readAll(os) : await os.fs.readFile(file);
      if (isGzip(archive)) archive = await transform(archive, new DecompressionStream("gzip"));
      for (const entry of unpack(archive)) {
        if (mode === "t" || verbose) await print(os, mode === "t" ? 1 : 2, `${entry.path}${entry.kind === "directory" ? "/" : ""}\n`);
        if (mode === "x") await extract(os, entry);
      }
    }
  } catch (error) {
    await print(os, 2, `tar: ${errorCode(error) === "EIO" ? (error as Error).message : errorCode(error)}\n`);
    return os.process.exit(2);
  }
  await os.process.exit(0);
}

/** A file, or a directory and everything under it. Leading '/' and './' are dropped, like GNU tar. */
async function collect(os: AppInterface, path: string, entries: Entry[]): Promise<void> {
  const stat = await os.fs.stat(path);
  const name = path.replace(/^(\.?\/)+/, "").replace(/\/+$/, "") || ".";
  const base = { path: name, mode: stat.mode, mtime: stat.modifiedAt };
  if (stat.kind === "file") {
    entries.push({ ...base, kind: "file", data: await os.fs.readFile(path) });
  } else if (stat.kind === "directory") {
    if (name !== ".") entries.push({ ...base, kind: "directory", data: new Uint8Array(0) });
    for (const child of await os.fs.readdir(path)) {
      const sub = `${path.replace(/\/+$/, "")}/${child.name}`;
      // One unreadable file shouldn't sink the whole archive.
      await collect(os, sub, entries).catch((error) => print(os, 2, `tar: ${sub}: ${errorCode(error)}, skipped\n`));
    }
  }
}

async function extract(os: AppInterface, entry: Entry): Promise<void> {
  if (entry.kind === "directory") return mkdirP(os, entry.path);
  const slash = entry.path.lastIndexOf("/");
  if (slash > 0) await mkdirP(os, entry.path.slice(0, slash));
  await os.fs.writeFile(entry.path, entry.data);
  await os.fs.chmod(entry.path, entry.mode & 0o777).catch(() => {}); // OPFS/owner rules may refuse; content matters more
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function readAll(os: AppInterface): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const chunk = await os.io.read(0, 65536);
    if (chunk.length === 0) break;
    chunks.push(chunk);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
