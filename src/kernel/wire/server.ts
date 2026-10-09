import { einval, enosys, logError } from "../errors";
import type { SyscallTable } from "../syscalls/table";
import type { Pid } from "../types";
import {
  isCallbackRef,
  isWirePath,
  parseAppMessage,
  serializeError,
  WIRE_CALLS,
  type CallMessage,
  type KernelMessage,
} from "./protocol";

export class PortServer {
  private closed = false;
  private readonly disposers = new Map<number, () => void>();
  private readonly released = new Set<number>();
  private readonly inflight = new Set<number>();

  private readonly port: MessagePort;
  private readonly pid: Pid;
  private readonly table: SyscallTable;
  private readonly onFault: (message: string, code?: string) => void;

  constructor(
    port: MessagePort,
    pid: Pid,
    table: SyscallTable,
    onFault: (message: string, code?: string) => void,
  ) {
    this.port = port;
    this.pid = pid;
    this.table = table;
    this.onFault = onFault;

    port.onmessage = (e) => this.receive(e.data);
    port.start();
  }

  private receive(data: unknown): void {
    const msg = parseAppMessage(data);

    if (msg === null || this.closed) return;

    switch (msg.t) {
      case "call":
        return this.dispatch(msg);
      case "release":
        return this.release(msg.cbId);
      case "fault":
        return this.onFault(msg.message, msg.code);
    }
  }

  private dispatch(msg: CallMessage): void {
    if (!isWirePath(msg.call)) return this.replyErr(msg.id, enosys(msg.call));
    const key = WIRE_CALLS[msg.call];
    if (key === null) return this.replyErr(msg.id, enosys(msg.call));

    const cbIds: number[] = [];
    const args = this.reviveArgs(msg.args, cbIds);
    const fn = this.table[key] as unknown as (
      pid: Pid,
      ...a: unknown[]
    ) => unknown;

    cbIds.forEach(this.inflight.add, this.inflight);

    let result: unknown;

    try {
      result = fn(this.pid, ...args);
    } catch (error) {
      this.settleInflight(cbIds);
      return this.replyErr(msg.id, error);
    }

    Promise.resolve(result).then(
      (value) => this.settle(msg.id, cbIds, value),
      (error) => {
        this.settleInflight(cbIds);
        this.replyErr(msg.id, error);
      },
    );
  }

  private reviveArgs(args: unknown[], cbIds: number[]): unknown[] {
    return args.map((arg) => {
      if (isCallbackRef(arg)) {
        cbIds.push(arg.$cb);

        return (...cbArgs: unknown[]) =>
          this.post({ t: "cb", cbId: arg.$cb, args: cbArgs });
      }

      return arg;
    });
  }

  /** The call these callbacks belong to has finished, one way or the other. */
  private settleInflight(cbIds: number[]): void {
    for (const cbId of cbIds) this.inflight.delete(cbId);
  }

  private settle(id: number, cbIds: number[], value: unknown): void {
    this.settleInflight(cbIds);
    if (typeof value !== "function") return this.replyOk(id, value);

    const dispose = value as () => void;
    if (cbIds.length !== 1) {
      this.safely(dispose);
      return this.replyErr(
        id,
        einval("call returned a disposer but has no single callback"),
      );
    }

    const cbId = cbIds[0];
    if (this.released.delete(cbId)) {
      this.safely(dispose);
      return this.replyOk(id, null);
    }

    this.disposers.set(cbId, dispose);
    this.replyOk(id, null);
  }

  private release(cbId: number): void {
    const dispose = this.disposers.get(cbId);
    if (!dispose) {
      // Unsubscribed while the call was still in flight: settle() disposes it.
      // Any other unknown id is ignored, so an app can't grow this set forever.
      if (this.inflight.has(cbId)) this.released.add(cbId);
      return;
    }

    this.disposers.delete(cbId);
    this.safely(dispose);
  }

  private post(msg: KernelMessage): void {
    if (this.closed) return;

    try {
      this.port.postMessage(msg);
    } catch (err) {
      if (msg.t === "ok") {
        this.replyErr(msg.id, {
          code: "EIO",
          message: `result of call ${msg.id} is not transferable`,
        });
      } else {
        logError(err);
      }
    }
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (e) {
      logError(e);
    }
  }

  private replyOk(id: number, value: unknown): void {
    this.post({ t: "ok", id, value });
  }

  private replyErr(id: number, error: unknown): void {
    this.post({ t: "err", id, error: serializeError(error) });
  }

  /** The process is terminating: let the runtime abort its local ProcessSignal. */
  public notifyAbort(reason: string): void {
    this.post({ t: "abort", reason });
  }

  /** Idempotent. Runs every kernel-side disposer and stops all traffic. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;

    const disposers = [...this.disposers.values()];
    this.disposers.clear();
    this.released.clear();
    this.inflight.clear();
    for (const dispose of disposers) this.safely(dispose);

    this.port.onmessage = null;
    this.port.close();
  }
}
