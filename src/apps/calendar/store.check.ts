// Self-check for store.ts: `node --import ./scripts/ts-resolve.js
// src/apps/calendar/store.check.ts` (or `pnpm check`).
//
// What it covers is the split between the shared list and this browser's own
// bookkeeping, which is hard to see from inside the app: two stores are
// opened over one fake filesystem, standing in for two browsers signed in as
// the owner. A third is opened over a filesystem that refuses /mnt/cloud,
// which is what everyone else meets.
import type { AppInterface } from "../../kernel/syscalls/api";
import { openStore, type Source, type Store } from "./store.ts";

let count = 0;
function ok(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const fail = (code: string): Error => Object.assign(new Error(code), { code });

// One clock for every fake browser: the server's modification times are the
// server's, and a browser that only ever saw its own would never notice
// anybody else's write.
const stamps = new Map<string, number>();
let clock = 1000;

/** Enough of os.fs to open a store, with a switch for the cloud mount. */
function fakeOs(files: Map<string, string>, cloud: boolean): AppInterface {
  const guard = (path: string): void => {
    if (!cloud && path.startsWith("/mnt/cloud")) throw fail("EACCES");
  };
  return {
    process: { env: () => Promise.resolve({ HOME: "/home/owner" }) },
    fs: {
      mkdir: (path: string) => {
        guard(path);
        if (files.has(`dir:${path}`)) return Promise.reject(fail("EEXIST"));
        files.set(`dir:${path}`, "");
        return Promise.resolve();
      },
      readTextFile: (path: string) => {
        guard(path);
        const body = files.get(path);
        return body === undefined ? Promise.reject(fail("ENOENT")) : Promise.resolve(body);
      },
      writeTextFile: (path: string, body: string) => {
        guard(path);
        files.set(path, body);
        stamps.set(path, ++clock);
        return Promise.resolve();
      },
      stat: (path: string) => {
        guard(path);
        if (!files.has(path)) return Promise.reject(fail("ENOENT"));
        return Promise.resolve({ modifiedAt: stamps.get(path) ?? 0 });
      },
      unlink: (path: string) => {
        files.delete(path);
        return Promise.resolve();
      },
    },
  } as unknown as AppInterface;
}

const CLOUD = "/mnt/cloud/calendar/subscriptions.json";
const LOCAL = "/home/owner/.config/calendar.json";

const shout = (message: string): never => {
  throw new Error(`unexpected error: ${message}`);
};

const add = (store: Store, id: string): void => {
  store.data.sources.push({
    id,
    kind: "url",
    url: `https://example.com/${id}.ics`,
    name: id,
    enabled: true,
    refreshMinutes: 60,
  });
  store.save();
};

const ids = (sources: readonly Source[]): string[] => sources.map((source) => source.id);
const onDisk = (files: Map<string, string>, path: string): { sources: Source[] } =>
  JSON.parse(files.get(path)!) as { sources: Source[] };
/** save() lets the cloud write settle before sending it. */
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 900));

// -- one browser, signed in -------------------------------------------------

const disk = new Map<string, string>();
const first = await openStore(fakeOs(disk, true), shout);
ok(first.backing, "cloud", "the mount answers, so the list is the shared one");
ok(disk.has(CLOUD), true, "an empty list still claims its place on the server");

add(first, "aaa");
await settle();
ok(ids(onDisk(disk, CLOUD).sources), ["aaa"], "a new subscription reaches the server");

// Bookkeeping belongs to the browser that did the syncing and must not travel.
first.data.sources[0]!.lastSync = 12345;
first.data.sources[0]!.lastError = "Couldn't reach that calendar.";
first.save();
await settle();
ok(Object.keys(onDisk(disk, CLOUD).sources[0]!).sort(),
  ["enabled", "id", "kind", "name", "url"], "only the person's half is shared");
ok(onDisk(disk, LOCAL).sources[0]!.lastSync, 12345, "the local copy keeps the rest");

// -- two browsers over one server -------------------------------------------

const a = await openStore(fakeOs(disk, true), shout);
ok(ids(a.data.sources), ["aaa"], "a second browser starts from the shared list");

const b = await openStore(fakeOs(disk, true), shout);
add(b, "bbb");
await settle();

ok(await a.pull(), true, "a's tick notices what b added");
ok(ids(a.data.sources), ["aaa", "bbb"], "and adopts the shared list");
ok(a.data.sources[1]!.lastSync, undefined, "without inventing bookkeeping for it");
ok(await a.pull(), false, "and finds nothing new on the next tick");

// A removal travels too, and takes the cached body with it.
disk.set("/home/owner/.config/calendar/aaa.ics", "BEGIN:VCALENDAR");
b.data.sources.splice(0, 1);
b.save();
await settle();
ok(await a.pull(), true, "a notices the removal");
ok(ids(a.data.sources), ["bbb"], "and drops the subscription");
ok(disk.has("/home/owner/.config/calendar/aaa.ics"), false, "its cached body goes with it");

// -- everyone else ----------------------------------------------------------

const alone = new Map<string, string>();
const visitor = await openStore(fakeOs(alone, false), shout);
ok(visitor.backing, "local", "a mount that refuses is just storage this browser hasn't got");
add(visitor, "ccc");
await settle();
ok(ids(onDisk(alone, LOCAL).sources), ["ccc"], "the list still saves, here");
ok(await visitor.pull(), false, "and there is nothing to pull");

// A list built before the server was reachable is handed over, not left behind.
const carried = new Map(alone);
const promoted = await openStore(fakeOs(carried, true), shout);
ok(promoted.backing, "cloud", "the mount answers this time");
ok(ids(onDisk(carried, CLOUD).sources), ["ccc"], "and takes the list this browser already had");

console.log(`calendar/store: ${count} checks passed`);
