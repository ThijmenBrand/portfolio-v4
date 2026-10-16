// The cloud filesystem's storage: one SQLite file holding a whole directory
// tree as rows. Backs /mnt/cloud in the browser OS, so the owner's app state
// is the same in every browser instead of living in that browser's OPFS.
//
// SQLite comes with Node (node:sqlite), so this adds no dependency. Storing
// paths as keys rather than as real files is the point: there is no directory
// to escape from, so path traversal isn't defended against, it's impossible.
//
// Concurrency: DatabaseSync is synchronous and Node is single-threaded, so a
// check and the write that depends on it cannot be interleaved by another
// request AS LONG AS no await sits between them. Every exported function here
// is sync on purpose; read the request body before calling one, never during.
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./auth.ts";
import { isUnder, nameOf, parentOf, ROOT } from "./fspath.ts";

export const MAX_FILE = 1024 * 1024; // 1 MiB per file
export const MAX_TOTAL = 32 * 1024 * 1024; // 32 MiB for everything
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
  version: number;
  created_at: number;
  modified_at: number;
}

const DB_PATH = process.env.CLOUD_DB ?? "/data/cloud.db";

// Fail at startup, not on the first request, like auth.ts's env checks.
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

const COLUMNS =
  "path, kind, LENGTH(data) AS size, version, created_at, modified_at";

const sql = {
  get: db.prepare(`SELECT ${COLUMNS} FROM node WHERE owner = ? AND path = ?`),
  getData: db.prepare("SELECT data, version, kind FROM node WHERE owner = ? AND path = ?"),
  children: db.prepare(`SELECT ${COLUMNS} FROM node WHERE owner = ? AND parent = ? ORDER BY path`),
  childCount: db.prepare("SELECT COUNT(*) AS n FROM node WHERE owner = ? AND parent = ?"),
  usage: db.prepare(
    "SELECT COUNT(*) AS nodes, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM node WHERE owner = ?",
  ),
  insert: db.prepare(
    "INSERT INTO node (owner, parent, path, kind, data, version, created_at, modified_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ),
  update: db.prepare(
    "UPDATE node SET data = ?, version = version + 1, modified_at = ? WHERE owner = ? AND path = ? AND kind = 'file' AND version = ?",
  ),
  replace: db.prepare(
    "UPDATE node SET data = ?, version = version + 1, modified_at = ? WHERE owner = ? AND path = ? AND kind = 'file'",
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

export function read(owner: string, path: string): { data: Buffer; version: number } {
  const found = sql.getData.get(owner, path) as
    | { data: Uint8Array | null; version: number; kind: Kind }
    | undefined;
  if (!found) throw enoent(path);
  if (found.kind !== "file") throw eisdir(path);
  return { data: Buffer.from(found.data ?? new Uint8Array(0)), version: found.version };
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
  data: Buffer,
  baseVersion: number | null,
): number {
  if (path === ROOT) throw eisdir(path);
  if (data.byteLength > MAX_FILE)
    throw new HttpError(413, `file is over ${MAX_FILE} bytes`, "EFBIG");

  return tx(() => {
    const existing = row(owner, path);
    const now = Date.now();

    if (!existing) {
      if (typeof baseVersion === "number" && baseVersion > 0) throw enoent(path);
      requireParent(owner, path);
      requireRoom(owner, data.byteLength, 1);
      sql.insert.run(owner, parentOf(path), path, "file", data, now, now);
      return 1;
    }

    if (baseVersion === 0) throw eexist(path);
    if (existing.kind !== "file") throw eisdir(path);
    requireRoom(owner, data.byteLength - (existing.size ?? 0), 0);

    if (baseVersion === null) {
      sql.replace.run(data, now, owner, path);
      return existing.version + 1;
    }
    // One statement, so nothing can slip between checking the version and
    // bumping it. No rows changed means someone else wrote first.
    const { changes } = sql.update.run(data, now, owner, path, baseVersion);
    if (changes === 0) throw econflict(path);
    return existing.version + 1;
  });
}

export function mkdir(owner: string, path: string): void {
  if (path === ROOT) throw eexist(path);
  tx(() => {
    if (row(owner, path)) throw eexist(path);
    requireParent(owner, path);
    requireRoom(owner, 0, 1);
    const now = Date.now();
    sql.insert.run(owner, parentOf(path), path, "directory", null, now, now);
  });
}

/**
 * Remove one entry. Not recursive: a directory must already be empty, which
 * is what the VFS expects of rmdir (it has no cascade of its own). Nothing
 * can be orphaned anyway, because every create checks its parent.
 */
export function remove(owner: string, path: string): void {
  if (path === ROOT) throw new HttpError(409, "cannot remove the root", "EBUSY");
  tx(() => {
    const found = row(owner, path);
    if (!found) throw enoent(path);
    if (found.kind === "directory") {
      const { n } = sql.childCount.get(owner, path) as { n: number };
      if (n > 0) throw enotempty(path);
    }
    sql.delete.run(owner, path);
  });
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

  tx(() => {
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
      return;
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
  });
}
