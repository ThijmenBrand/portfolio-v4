import { KernelError } from "../errors";
import type { AppInterface } from "../syscalls/api";
import type { SyscallTable } from "../syscalls/table";
import type { Pid } from "../types";

export const PROTOCOL_VERSION = 1;

export interface CallbackRef {
  readonly $cb: number;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

export interface BootMessage {
  t: "boot";
  v: typeof PROTOCOL_VERSION;
  pid: Pid;
  path: string;
  /** Which app module to load inside the realm, e.g. "cat" -> apps/cat/main.ts. */
  entry: string;
  args: string[];
}

export interface CallMessage {
  t: "call";
  id: number;
  call: string;
  args: unknown[];
}

export interface ReleaseMessage {
  t: "release";
  cbId: number;
}

export interface FaultMessage {
  t: "fault";
  message: string;
  /** KernelError code when main() died on one (ENOENT, EBADF, ...). */
  code?: string;
}

export type AppMessage = CallMessage | ReleaseMessage | FaultMessage;

export interface OkMessage {
  t: "ok";
  id: number;
  value: unknown;
}

export interface ErrMessage {
  t: "err";
  id: number;
  error: SerializedError;
}

export interface CallbackMessage {
  t: "cb";
  cbId: number;
  args: unknown[];
}

export interface AbortMessage {
  t: "abort";
  reason: string;
}

export type KernelMessage =
  | OkMessage
  | ErrMessage
  | CallbackMessage
  | AbortMessage;

type Paths<I> = {
  [NS in keyof I & string]: {
    [M in keyof I[NS] & string]: `${NS}.${M}`;
  }[keyof I[NS] & string];
}[keyof I & string];

type RuntimeLocal =
  | "process.signal"
  | "process.pid"
  | `timers.${string}`
  | "fs.readTextFile"
  | "fs.writeTextFile";

export type WirePath = Exclude<Paths<AppInterface>, RuntimeLocal>;

export const WIRE_CALLS = {
  "display.workArea": "getWorkArea",

  // Returns a handle object; needs handle-by-id support (iframe milestone).
  "windows.create": null,
  "windows.list": "listWindows",
  "windows.focus": "focusWindow",
  "windows.setMinimized": "setMinimized",

  "process.onSignal": "onSignal",
  "process.wait": "wait",
  "process.spawn": "spawn",
  "process.exit": "exit",
  "process.list": "list",
  "process.kill": "kill",
  "process.history": "history",
  "process.chdir": "chdir",
  "process.cwd": "cwd",

  "events.subscribe": "subscribe",

  "fs.readFile": "readFile",
  "fs.writeFile": "writeFile",
  "fs.readdir": "readDir",
  "fs.stat": "stat",
  "fs.mkdir": "mkdir",
  "fs.unlink": "unlink",

  "io.open": "open",
  "io.close": "close",
  "io.read": "read",
  "io.write": "write",
  "io.seek": "seek",
  "io.dup": "dup",
  "io.fstat": "fstat",
  "io.listFds": "listFds",
  "io.pipe": "pipe",
  "io.openpty": "openpty",
} as const satisfies Record<WirePath, keyof SyscallTable | null>;

/** The AppInterface member a wire path names, e.g. Member<"io.read">. */
export type Member<P extends string> = P extends `${infer NS}.${infer M}`
  ? NS extends keyof AppInterface
    ? M extends keyof AppInterface[NS]
      ? AppInterface[NS][M]
      : never
    : never
  : never;

type DropCaller<F> = F extends (caller: Pid, ...rest: infer R) => any
  ? R
  : never;

type Misaligned = {
  [P in WirePath]: (typeof WIRE_CALLS)[P] extends keyof SyscallTable
    ? Member<P> extends (...args: infer A) => any
      ? Required<A> extends DropCaller<SyscallTable[(typeof WIRE_CALLS)[P]]>
        ? never
        : P
      : P
    : never;
}[WirePath];

type AssertNever<T extends never> = T;
export type WireCallsAligned = AssertNever<Misaligned>;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isId(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/** Own-key check: "constructor" / "__proto__" / "toString" must not resolve. */
export function isWirePath(x: unknown): x is WirePath {
  return typeof x === "string" && Object.hasOwn(WIRE_CALLS, x);
}

export function isCallbackRef(x: unknown): x is CallbackRef {
  return isRecord(x) && isId(x.$cb) && Object.keys(x).length === 1;
}

export function parseAppMessage(data: unknown): AppMessage | null {
  if (!isRecord(data)) return null;
  switch (data.t) {
    case "call":
      return isId(data.id) &&
        typeof data.call === "string" &&
        Array.isArray(data.args)
        ? (data as unknown as CallMessage)
        : null;
    case "release":
      return isId(data.cbId) ? (data as unknown as ReleaseMessage) : null;
    case "fault":
      return typeof data.message === "string" &&
        (data.code === undefined || typeof data.code === "string")
        ? (data as unknown as FaultMessage)
        : null;
    default:
      return null;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof KernelError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "EIO", message };
}

export function deserializeError(error: SerializedError): KernelError {
  return new KernelError(error.code, error.message, error.details);
}
