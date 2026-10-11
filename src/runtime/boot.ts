import { KernelError } from "../kernel/errors";
import type { AppInterface } from "../kernel/syscalls/api";
import { PROTOCOL_VERSION, type BootMessage } from "../kernel/wire/protocol";
import { WireClient } from "./client";
import { buildAppInterface } from "./os";

/** What an out-of-realm app module exports. Same shape for workers and iframes. */
export interface RealmAppModule {
  main(os: AppInterface, args: string[]): void | Promise<void>;
}

export type AppLoaders = Record<string, () => Promise<RealmAppModule>>;

export function isBoot(data: unknown, port: MessagePort | undefined): data is BootMessage {
  const boot = data as BootMessage | undefined;
  return boot?.t === "boot" && boot.v === PROTOCOL_VERSION && port !== undefined;
}

/** Split an error into the fault message's fields, keeping a KernelError's code. */
function describe(error: unknown): { message: string; code?: string } {
  if (error instanceof KernelError) return { message: error.message, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Connect to the kernel over `port`, load the app named in the boot message
 * and run it. A crash in main() is reported as a fault: neither a worker's
 * nor an iframe's unhandled rejection ever reaches the kernel on its own.
 */
export async function runApp(
  boot: BootMessage,
  port: MessagePort,
  apps: AppLoaders,
): Promise<void> {
  const client = new WireClient(port);
  try {
    // entry is a module path relative to src/, e.g. "bin/cat/main".
    const load = apps[`../${boot.entry}.ts`];
    if (!load) throw new KernelError("ENOEXEC", `not an app for this realm: ${boot.entry}`);
    const module = await load();
    await module.main(buildAppInterface(client, boot.pid), boot.args);
    // main() returning does not end the process — same as in-page.
  } catch (error) {
    const { message, code } = describe(error);
    client.fault(message, code);
  }
}

/**
 * A worker realm's boot: re-delivered by the worker's bootstrap
 * (src/runtime/worker-frame.ts) once the entry module has loaded, carrying
 * the kernel port.
 */
export function bootWorker(apps: AppLoaders): void {
  self.onmessage = (event: MessageEvent) => {
    self.onmessage = null; // boot exactly once
    const port = event.ports[0];
    if (!port || !isBoot(event.data, port)) {
      self.close(); // not from our kernel, or a version mismatch
      return;
    }
    void runApp(event.data, port, apps);
  };
}
