// The cloud filesystem's storage: one SQLite file holding a whole directory
// tree as rows. Backs /mnt/cloud in the browser OS, so the owner's app state
// is the same in every browser instead of living in that browser's OPFS.
//
// SQLite comes with Node (node:sqlite), so this adds no dependency. Storing
// paths as keys rather than as real files is the point: there is no directory
// to escape from, so path traversal isn't defended against, it's impossible.
//
// The database holds the tree, never the bytes: every file's contents are a
// file of their own in DOCS_DIR, named by a random id its row holds. A move
// rewrites rows, never files, and the name says nothing about the path. The
// row stays the truth: a file there is written before its row commits and
// deleted after its row is gone, so a crash leaves at worst an unreferenced
// file, never a row without its bytes. Every write is a new file, so a read
// in progress keeps the bytes it opened.
//
// Concurrency: DatabaseSync is synchronous and Node is single-threaded, so a
// check and the write that depends on it cannot be interleaved by another
// request AS LONG AS no await sits between them. Every exported function here
// is sync on purpose; read the request body before calling one, never during.
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./auth.ts";
import { isUnder, nameOf, parentOf, ROOT } from "./fspath.ts";

export const MAX_FILE = 20 * 1024 * 1024; // 20 MiB per file, the apps' upload limit
const QUOTA_MB = Number(process.env.CLOUD_QUOTA_MB ?? 1024);
if (!Number.isInteger(QUOTA_MB) || QUOTA_MB < 1)
  throw new Error(`CLOUD_QUOTA_MB must be a whole number of MiB, not ${process.env.CLOUD_QUOTA_MB}`);
export const MAX_TOTAL = QUOTA_MB * 1024 * 1024; // for everything, both places
export const MAX_NODES = 5000;
/** Rows one move may rewrite. A long cascade blocks the event loop, and the
 *  healthcheck restarts the container after three missed probes. */
const MAX_REWRITE = 2000;

export type Kind = "file" | "directory";

export interface Entry {
  name: string;
  path: string;
  kind: Kind;
  size: number;
  version: number;
  createdAt: number;
  modifiedAt: number;
}

interface Row {
  path: string;
  kind: Kind;
  size: number | null;
  /** The file in DOCS_DIR holding the bytes; null for a directory. */
  blob: string | null;
  version: number;
  created_at: number;
  modified_at: number;
}

const DB_PATH = process.env.CLOUD_DB ?? "/data/cloud.db";
// Production mounts /docs (deploy/docker-compose.yml); dev keeps it next to the repo.
const DOCS_DIR = process.env.CLOUD_DOCS ?? "./cloud-docs";

// Like the database: a missing or unwritable mount fails at startup, not on
// the first big upload.
mkdirSync(DOCS_DIR, { recursive: true });
accessSync(DOCS_DIR, constants.R_OK | constants.W_OK);

// Fail at startup, not on the first request, like auth.ts's env checks.
// `data` is where the first databases kept every file's bytes; nothing
// writes it any more, and migrateInline() empties it.
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS node (
    owner       TEXT    NOT NULL,
    parent      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    data        BLOB,
    version     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    PRIMARY KEY (owner, path)
  ) STRICT;
`);
db.exec("CREATE INDEX IF NOT EXISTS node_parent ON node(owner, parent)");
// Added after the first databases were made: those get the columns here.
const columns = db.prepare("PRAGMA table_info(node)").all() as { name: string }[];
if (!columns.some((column) => column.name === "blob")) {
  db.exec("ALTER TABLE node ADD COLUMN blob TEXT");
  db.exec("ALTER TABLE node ADD COLUMN blob_size INTEGER");
}

const SIZE = "COALESCE(blob_size, 0)";
const COLUMNS = `path, kind, ${SIZE} AS size, blob, version, created_at, modified_at`;

const sql = {
  get: db.prepare(`SELECT ${COLUMNS} FROM node WHERE owner = ? AND path = ?`),
  getData: db.prepare("SELECT blob, blob_size, version, kind FROM node WHERE owner = ? AND path = ?"),
  children: db.prepare(`SELECT ${COLUMNS} FROM node WHERE owner = ? AND parent = ? ORDER BY path`),
  childCount: db.prepare("SELECT COUNT(*) AS n FROM node WHERE owner = ? AND parent = ?"),
  usage: db.prepare(
    `SELECT COUNT(*) AS nodes, COALESCE(SUM(${SIZE}), 0) AS bytes FROM node WHERE owner = ?`,
  ),
  insert: db.prepare(
    "INSERT INTO node (owner, parent, path, kind, blob, blob_size, version, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ),
  update: db.prepare(
    "UPDATE node SET blob = ?, blob_size = ?, version = version + 1, modified_at = ? WHERE owner = ? AND path = ? AND kind = 'file' AND version = ?",
  ),
  replace: db.prepare(
    "UPDATE node SET blob = ?, blob_size = ?, version = version + 1, modified_at = ? WHERE owner = ? AND path = ? AND kind = 'file'",
  ),
  delete: db.prepare("DELETE FROM node WHERE owner = ? AND path = ?"),
  // substr(), never LIKE: LIKE would treat % and _ in a user-supplied prefix
  // as wildcards, and is case-insensitive for ASCII, so removing "/Notes"
  // would also match "/notes" -- a different row under binary collation.
  subtree: db.prepare(
    `SELECT ${COLUMNS} FROM node WHERE owner = ? AND substr(path, 1, length(?)) = ?`,
  ),
  rekey: db.prepare(
    "UPDATE node SET path = ?, parent = ?, modified_at = ? WHERE owner = ? AND path = ?",
  ),
} as const;

const enoent = (path: string) => new HttpError(404, `no such file: ${path}`, "ENOENT");
const enotdir = (path: string) => new HttpError(409, `not a directory: ${path}`, "ENOTDIR");
const eisdir = (path: string) => new HttpError(409, `is a directory: ${path}`, "EISDIR");
const eexist = (path: string) => new HttpError(409, `already exists: ${path}`, "EEXIST");
const enotempty = (path: string) => new HttpError(409, `not empty: ${path}`, "ENOTEMPTY");
const econflict = (path: string) => new HttpError(409, `changed elsewhere: ${path}`, "EBUSY");
const enospc = (why: string) => new HttpError(507, why, "ENOSPC");

const efbig = () => new HttpError(413, `file is over ${MAX_FILE} bytes`, "EFBIG");

// ------------------------------------------------------------ documents --

/** A file's new bytes, already written to DOCS_DIR under a newBlob() name. */
export type Content = { blob: string; size: number };

/** A file's bytes as read: open in DOCS_DIR, to stream and then close. */
export type Contents = { version: number; fd: number; size: number };

/** A fresh name in DOCS_DIR for an upload to be written to. */
export const newBlob = (): string => randomUUID();

export const blobPath = (blob: string): string => join(DOCS_DIR, blob);

/** Delete a file in DOCS_DIR; one already gone is fine. */
export function dropBlob(blob: string | null): void {
  if (blob) rmSync(blobPath(blob), { force: true });
}

/** Bytes already in memory, written to a new file in DOCS_DIR and synced. */
export function putBlob(data: Uint8Array): Content {
  const blob = newBlob();
  const fd = openSync(blobPath(blob), "wx", 0o600);
  try {
    for (let at = 0; at < data.byteLength; ) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    dropBlob(blob);
    throw error;
  }
  closeSync(fd);
  return { blob, size: data.byteLength };
}

/**
 * Move bytes still in rows out to DOCS_DIR: a database from before every
 * file lived there, or a row an older image wrote after a rollback (it sets
 * `data` and leaves `blob` stale, so `data` wins). Each file is synced before
 * the transaction that points rows at them commits; a crash in between
 * leaves unreferenced files and rows that are simply migrated again.
 * Returns how many rows moved.
 */
export function migrateInline(): number {
  const legacy = db
    .prepare(
      "SELECT owner, path, data, blob FROM node WHERE kind = 'file' AND (data IS NOT NULL OR blob IS NULL)",
    )
    .all() as { owner: string; path: string; data: Uint8Array | null; blob: string | null }[];
  if (legacy.length === 0) return 0;
  const written: string[] = [];
  const set = db.prepare(
    "UPDATE node SET data = NULL, blob = ?, blob_size = ? WHERE owner = ? AND path = ?",
  );
  try {
    tx(() => {
      for (const { owner, path, data } of legacy) {
        const { blob, size } = putBlob(data ?? new Uint8Array(0));
        written.push(blob);
        set.run(blob, size, owner, path);
      }
    });
  } catch (error) {
    for (const blob of written) dropBlob(blob);
    throw error;
  }
  for (const { blob } of legacy) dropBlob(blob);
  // Give the space the bytes took back to the disk.
  db.exec("VACUUM");
  return legacy.length;
}

function toEntry(row: Row): Entry {
  return {
    name: nameOf(row.path),
    path: row.path,
    kind: row.kind,
    size: row.size ?? 0,
    version: row.version,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

/** The root is implicit: it is never a row, and it always exists. */
function rootEntry(): Entry {
  return {
    name: "",
    path: ROOT,
    kind: "directory",
    size: 0,
    version: 1,
    createdAt: 0,
    modifiedAt: 0,
  };
}

function row(owner: string, path: string): Row | undefined {
  return sql.get.get(owner, path) as Row | undefined;
}

/** node:sqlite types rows as plain records; the columns are ours to name. */
function rows(result: unknown): Row[] {
  return result as Row[];
}

function tx<T>(run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Throws unless `path`'s parent exists and is a directory. */
function requireParent(owner: string, path: string): void {
  const parent = parentOf(path);
  if (parent === ROOT) return;
  const found = row(owner, parent);
  if (!found) throw enoent(parent);
  if (found.kind !== "directory") throw enotdir(parent);
}

/** Throws when adding `added` bytes and `nodes` rows would pass a limit. */
function requireRoom(owner: string, added: number, nodes: number): void {
  const { bytes, nodes: count } = usage(owner);
  if (bytes + added > MAX_TOTAL)
    throw enospc(`out of space (${MAX_TOTAL} bytes total)`);
  if (count + nodes > MAX_NODES)
    throw enospc(`too many files (${MAX_NODES} max)`);
}

export function usage(owner: string): { bytes: number; nodes: number } {
  const seen = sql.usage.get(owner) as { nodes: number; bytes: number };
  return { bytes: Number(seen.bytes), nodes: Number(seen.nodes) };
}

export function stat(owner: string, path: string): Entry {
  if (path === ROOT) return rootEntry();
  const found = row(owner, path);
  if (!found) throw enoent(path);
  return toEntry(found);
}

export function list(owner: string, path: string): Entry[] {
  const dir = stat(owner, path);
  if (dir.kind !== "directory") throw enotdir(path);
  return rows(sql.children.all(owner, path)).map(toEntry);
}

export function read(owner: string, path: string): Contents {
  const found = sql.getData.get(owner, path) as
    | { blob: string | null; blob_size: number | null; version: number; kind: Kind }
    | undefined;
  if (!found) throw enoent(path);
  if (found.kind !== "file" || !found.blob) throw eisdir(path);
  // Opened here, with no await since the lookup: a write that replaces the
  // file afterwards deletes the name, and the open descriptor still reads.
  return { fd: openSync(blobPath(found.blob), "r"), size: found.blob_size ?? 0, version: found.version };
}

/**
 * Write a file's bytes, returning its new version. What `baseVersion` asks
 * for:
 *
 *   null  create or replace, whoever got there last. This is what a plain
 *         "save this file" means: the caller never read what was there, so
 *         it has no version to stand on and nothing to be surprised by.
 *   0     it must not exist yet (a create).
 *   n     it must still be at n, or someone else wrote in the meantime and
 *         this one is rejected. Only a caller that actually read the file
 *         can say this, which is what makes the answer worth anything.
 */
export function write(
  owner: string,
  path: string,
  content: Content,
  baseVersion: number | null,
): number {
  const { blob, size } = content;
  let replaced: string | null = null;
  let version: number;
  try {
    if (path === ROOT) throw eisdir(path);
    if (size > MAX_FILE) throw efbig();

    version = tx(() => {
      const existing = row(owner, path);
      const now = Date.now();

      if (!existing) {
        if (typeof baseVersion === "number" && baseVersion > 0) throw enoent(path);
        requireParent(owner, path);
        requireRoom(owner, size, 1);
        sql.insert.run(owner, parentOf(path), path, "file", blob, size, now, now);
        return 1;
      }

      if (baseVersion === 0) throw eexist(path);
      if (existing.kind !== "file") throw eisdir(path);
      requireRoom(owner, size - (existing.size ?? 0), 0);

      if (baseVersion === null) {
        sql.replace.run(blob, size, now, owner, path);
      } else {
        // One statement, so nothing can slip between checking the version and
        // bumping it. No rows changed means someone else wrote first.
        const { changes } = sql.update.run(blob, size, now, owner, path, baseVersion);
        if (changes === 0) throw econflict(path);
      }
      replaced = existing.blob;
      return existing.version + 1;
    });
  } catch (error) {
    // The upload's own file: refused, so nothing will ever point at it.
    dropBlob(blob);
    throw error;
  }
  // Only once the row no longer points at it.
  dropBlob(replaced);
  return version;
}

export function mkdir(owner: string, path: string): void {
  if (path === ROOT) throw eexist(path);
  tx(() => {
    if (row(owner, path)) throw eexist(path);
    requireParent(owner, path);
    requireRoom(owner, 0, 1);
    const now = Date.now();
    sql.insert.run(owner, parentOf(path), path, "directory", null, null, now, now);
  });
}

/**
 * Remove one entry. Not recursive: a directory must already be empty, which
 * is what the VFS expects of rmdir (it has no cascade of its own). Nothing
 * can be orphaned anyway, because every create checks its parent.
 */
export function remove(owner: string, path: string): void {
  if (path === ROOT) throw new HttpError(409, "cannot remove the root", "EBUSY");
  const gone = tx(() => {
    const found = row(owner, path);
    if (!found) throw enoent(path);
    if (found.kind === "directory") {
      const { n } = sql.childCount.get(owner, path) as { n: number };
      if (n > 0) throw enotempty(path);
    }
    sql.delete.run(owner, path);
    return found.blob;
  });
  dropBlob(gone);
}

/**
 * Move `from` onto `to`, replacing what is there (the VFS has checked the
 * kinds match, but this holds the data, so it checks again). A directory
 * takes its whole subtree with it, in one transaction.
 */
export function move(owner: string, from: string, to: string): void {
  if (from === ROOT || to === ROOT) throw new HttpError(409, "cannot move the root", "EBUSY");
  if (from === to) return;
  if (isUnder(to, from))
    throw new HttpError(409, `cannot move ${from} into itself`, "EINVAL");

  const replaced = tx((): string | null => {
    const source = row(owner, from);
    if (!source) throw enoent(from);
    requireParent(owner, to);

    const target = row(owner, to);
    if (target) {
      if (source.kind === "directory" && target.kind !== "directory") throw enotdir(to);
      if (source.kind !== "directory" && target.kind === "directory") throw eisdir(to);
      if (target.kind === "directory") {
        const { n } = sql.childCount.get(owner, to) as { n: number };
        if (n > 0) throw enotempty(to);
      }
      sql.delete.run(owner, to);
    }

    const now = Date.now();
    if (source.kind !== "directory") {
      sql.rekey.run(to, parentOf(to), now, owner, from);
      return target?.blob ?? null;
    }

    const prefix = `${from}/`;
    const descendants = rows(sql.subtree.all(owner, prefix, prefix));
    if (descendants.length + 1 > MAX_REWRITE)
      throw new HttpError(409, `too many entries to move (${MAX_REWRITE} max)`, "EBUSY");
    sql.rekey.run(to, parentOf(to), now, owner, from);
    for (const node of descendants) {
      const moved = to + node.path.slice(from.length);
      sql.rekey.run(moved, parentOf(moved), now, owner, node.path);
    }
    // A directory only ever replaces an empty directory: nothing to delete.
    return null;
  });
  dropBlob(replaced);
}

// Last, once everything above exists. Startup, not a request, so a database
// this can't migrate stops the api before it serves anything.
const migrated = migrateInline();
if (migrated > 0) console.log(`cloud: moved ${migrated} files out of the database into ${DOCS_DIR}`);
