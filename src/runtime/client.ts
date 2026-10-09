import { logError } from "../kernel/errors";
import {
  deserializeError,
  type AppMessage,
  type KernelMessage,
  type WirePath,
} from "../kernel/wire/protocol";

type Callback = (...args: unknown[]) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cbIds: number[];
}

/**
 * App-side end of the wire. Runs inside the worker (later: the iframe).
 *
 * Mirror image of PortServer: turns calls into `call` messages, matches
 * `ok`/`err` replies back to their promise by id, and turns callback
 * arguments into `{ $cb }` refs the kernel can invoke later.
 *
 * Unlike the server, this side trusts what it receives: the kernel is
 * the trusted party, the app is not.
 */
export class WireClient {
  private nextId = 1;
  private nextCbId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly callbacks = new Map<number, Callback>();

  readonly abort = new AbortController();

  private readonly port: MessagePort;

  constructor(port: MessagePort) {
    this.port = port;
    port.onmessage = (e) => this.receive(e.data as KernelMessage);
    port.start();
  }

  call(path: WirePath, args: unknown[]): Promise<unknown> {
    return this.send(path, args).promise;
  }

  async callWithDisposer(path: WirePath, args: unknown[]): Promise<() => void> {
    const { promise, cbIds } = this.send(path, args);
    await promise;
    if (cbIds.length !== 1) {
      throw new Error(`${path}: expected exactly one callback argument`);
    }
    const cbId = cbIds[0];
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(cbId);
    };
  }

  release(cbId: number): void {
    this.callbacks.delete(cbId);
    this.post({ t: "release", cbId });
  }

  fault(message: string): void {
    this.post({ t: "fault", message });
  }

  private send(
    path: WirePath,
    args: unknown[],
  ): { promise: Promise<unknown>; cbIds: number[] } {
    const id = this.nextId++;
    const cbIds: number[] = [];

    const wireArgs = args.map((arg) => {
      if (typeof arg !== "function") return arg;
      const cbId = this.nextCbId++;
      this.callbacks.set(cbId, arg as Callback);
      cbIds.push(cbId);
      return { $cb: cbId };
    });

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, cbIds });
      try {
        this.post({ t: "call", id, call: path, args: wireArgs });
      } catch (error) {
        this.pending.delete(id);
        this.dropCallbacks(cbIds);
        reject(error);
      }
    });

    return { promise, cbIds };
  }

  private receive(msg: KernelMessage): void {
    switch (msg.t) {
      case "ok": {
        const call = this.take(msg.id);
        call?.resolve(msg.value);
        return;
      }
      case "err": {
        const call = this.take(msg.id);
        if (!call) return;
        this.dropCallbacks(call.cbIds);
        call.reject(deserializeError(msg.error));
        return;
      }
      case "cb": {
        const callback = this.callbacks.get(msg.cbId);
        if (!callback) return;
        try {
          callback(...msg.args);
        } catch (error) {
          logError(error);
        }
        return;
      }
      case "abort":
        this.abort.abort(msg.reason);
        return;
    }
  }

  private take(id: number): Pending | undefined {
    const call = this.pending.get(id);
    this.pending.delete(id);
    return call;
  }

  private dropCallbacks(cbIds: number[]): void {
    for (const cbId of cbIds) this.callbacks.delete(cbId);
  }

  private post(msg: AppMessage): void {
    this.port.postMessage(msg);
  }
}
