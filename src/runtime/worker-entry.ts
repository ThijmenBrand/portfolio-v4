import { KernelError } from "../kernel/errors";
import type { AppInterface } from "../kernel/syscalls/api";
import { PROTOCOL_VERSION, type BootMessage } from "../kernel/wire/protocol";
import { WireClient } from "./client";
import { buildAppInterface } from "./os";

interface WorkerAppModule {
  main(os: AppInterface, args: string[]): void | Promise<void>;
}

/**
 * The apps that may run in a worker. Listed explicitly rather than
 * "../apps/*" so DOM-touching apps (terminal, IoDebug, ...) are never
 * bundled into the worker. Add an app here when you give it
 * `format: "worker"` in binfmt.
 */
const apps = import.meta.glob<WorkerAppModule>([
  "../apps/echo/main.ts",
  "../apps/cat/main.ts",
  "../apps/loop/main.ts",
]);

/** Split an error into the fault message's fields, keeping a KernelError's code. */
function describe(error: unknown): { message: string; code?: string } {
  if (error instanceof KernelError) return { message: error.message, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

self.onmessage = async (event: MessageEvent) => {
  self.onmessage = null;

  const boot = event.data as BootMessage;
  const port = event.ports[0];
  if (boot?.t !== "boot" || boot.v !== PROTOCOL_VERSION || !port) {
    self.close();
    return;
  }

  const client = new WireClient(port);
  try {
    const load = apps[`../apps/${boot.entry}/main.ts`];
    if (!load)
      throw new KernelError("ENOEXEC", `not a worker app: ${boot.entry}`);

    const module = await load();
    await module.main(buildAppInterface(client, boot.pid), boot.args);
  } catch (error) {
    const { message, code } = describe(error);
    client.fault(message, code);
  }
};
