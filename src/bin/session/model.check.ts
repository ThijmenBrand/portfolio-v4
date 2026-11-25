// Self-check for model.ts: `node src/bin/session/model.check.ts` (or `pnpm check`).
import { fit, hasSession, parseSession, plan, restorable, serialize, snapshot } from "./model.ts";

let count = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}\n  expected ${b}\n  actual   ${a}`);
  count++;
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const proc = (pid: number, path: string, args: string[] = [], status = "running") =>
  ({ pid, path, args, status }) as never;
const win = (pid: number, extra: object = {}) =>
  ({
    windowId: pid * 10,
    pid,
    title: "",
    minimized: false,
    state: "normal",
    frame: rect(10, 20, 300, 200),
    focused: false,
    ...extra,
  }) as never;

// -- restorable: programs and the user's own apps, never system ones
eq(restorable("/ProgramFiles/terminal", "/home/me"), true, "program");
eq(restorable("/System/Taskbar", "/home/me"), false, "taskbar is autostart's");
eq(restorable("/home/me/.local/share/apps/a.js", "/home/me"), true, "user app");
eq(restorable("/home/other/x.js", "/home/me"), false, "someone else's");
eq(restorable("/anything", "/"), false, "no home, no user apps");

// -- snapshot
const procs = [
  proc(2, "/ProgramFiles/terminal"),
  proc(3, "/ProgramFiles/calendar"),
  proc(4, "/System/Taskbar"),
  proc(5, "/ProgramFiles/resume", [], "zombie"),
  proc(6, "/ProgramFiles/jsapp", ["/home/me/a.js"]),
];
const taken = snapshot(
  [
    win(2),
    win(3, { state: "maximized", frame: rect(0, 0, 1920, 1000), restoreFrame: rect(50, 60, 800, 600), focused: true }),
    win(4),
    win(5),
    win(6, { state: "tiled", tile: "left", frame: rect(0, 0, 960, 1000), restoreFrame: rect(5, 5, 400, 300) }),
    win(99),
    win(2, { windowId: 21 }),
  ],
  procs,
  "/home/me",
);
eq(
  taken.map((entry) => [entry.path, entry.state, entry.frame.width, entry.tile ?? null, entry.focused ?? false]),
  [
    ["/ProgramFiles/terminal", "normal", 300, null, false],
    ["/ProgramFiles/calendar", "maximized", 800, null, true],
    ["/ProgramFiles/jsapp", "tiled", 400, "left", false],
  ],
  "snapshot keeps restorable windows, once per process, at their floating size",
);
eq(taken[2]!.args, ["/home/me/a.js"], "arguments are kept");

// -- plan: what autostart already opened is adopted, not opened twice
const saved = taken.map(({ windowId: _id, pid: _pid, ...entry }) => entry);
const openNow = (...i: number[]) => i.map((n) => ({ ...taken[n]!, windowId: 100 + n }));
eq(plan(saved, []).reopen.length, 3, "nothing open: everything is reopened");
eq(plan(saved, []).adopt.length, 0, "nothing open: nothing to adopt");
eq(
  plan(saved, openNow(0)).reopen.map((entry) => entry.path),
  ["/ProgramFiles/jsapp", "/ProgramFiles/calendar"],
  "an open one is not reopened, and the focused one goes last",
);
eq(plan(saved, openNow(0)).adopt, [{ entry: saved[0], windowId: 100 }], "it is adopted by window id");
eq(
  plan([saved[0]!, saved[0]!], openNow(0)).reopen.length,
  1,
  "two saved terminals, one already open: one more",
);
eq(
  plan([saved[2]!], [{ ...taken[2]!, args: ["/home/me/b.js"], windowId: 7 }]).reopen.length,
  1,
  "same program with other arguments is a different window",
);
eq(JSON.parse(serialize(taken)).windows[0].windowId, undefined, "ids are not written");
eq(JSON.parse(serialize(taken)).windows[0].pid, undefined, "pids are not written");

// -- extra: open windows the saved session does not list (autostart's) are the session's to overrule
eq(plan([], openNow(0, 1)).extra.map((win) => win.pid), [2, 3], "an empty session overrules everything open");
eq(plan(saved, openNow(0, 1)).extra, [], "windows the session lists are kept");
eq(plan([saved[0]!], openNow(0, 1)).extra.map((win) => win.pid), [3], "only the unlisted one is extra");
eq(plan([saved[0]!, saved[0]!], openNow(0)).extra, [], "adopted windows are never extra");

// -- hasSession: a file with no windows is a session; no file is not
eq(hasSession(null), false, "no file");
eq(hasSession("garbage"), false, "not json");
eq(hasSession('{"windows": []}'), true, "everything was closed");
eq(hasSession(serialize([])), true, "our own empty file");

// -- fit: a smaller screen pulls windows back in
const area = rect(0, 32, 1000, 700);
eq(fit(rect(50, 60, 300, 200), area), rect(50, 60, 300, 200), "already fits");
eq(fit(rect(900, 60, 300, 200), area), rect(700, 60, 300, 200), "pulled in from the right");
eq(fit(rect(-50, 0, 300, 200), area), rect(0, 32, 300, 200), "pulled in from the left and top");
eq(fit(rect(0, 32, 2000, 2000), area), rect(0, 32, 1000, 700), "shrunk to the screen");

// -- parseSession: hand-edited files are survivable
eq(parseSession(null), [], "no file");
eq(parseSession("not json"), [], "garbage");
eq(parseSession('{"windows": 3}'), [], "wrong shape");
eq(
  parseSession(
    JSON.stringify({
      windows: [
        { path: "relative", args: [], frame: rect(0, 0, 1, 1) },
        { path: "/ProgramFiles/a", args: [1], frame: rect(0, 0, 1, 1) },
        { path: "/ProgramFiles/b", args: [], frame: { x: "0" } },
        { path: "/ProgramFiles/c", args: [], frame: rect(1, 2, 3, 4), state: "tiled", tile: "nonsense" },
        { path: "/ProgramFiles/d", args: ["x"], frame: rect(1, 2, 3, 4), state: "tiled", tile: "left", focused: true },
      ],
    }),
  ).map((entry) => [entry.path, entry.state, entry.tile ?? null]),
  [
    ["/ProgramFiles/c", "normal", null],
    ["/ProgramFiles/d", "tiled", "left"],
  ],
  "bad entries dropped, a bad tile becomes a floating window",
);
eq(parseSession(serialize(saved)), saved, "round trip");

console.log(`session model: ${count} checks passed`);
