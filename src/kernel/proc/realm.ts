import type { KernelContext, Process } from "../types";
import type { WindowOptions } from "../windows/types";
import { PROTOCOL_VERSION, type BootMessage } from "../wire/protocol";
import type { PortServer } from "../wire/server";
import { faultProcess } from "./faultproc";

/**
 * Wiring shared by every out-of-realm process: a fresh channel, a server
 * bound to this pid on our end, the kill path, and abort forwarding.
 * Returns the server and the port to hand to the realm in its boot message.
 */
function connectRealm(
  ctx: KernelContext,
  proc: Process,
  destroyRealm: () => void,
): { server: PortServer; port: MessagePort } {
  const channel = new MessageChannel();
  const server = ctx.serve(channel.port1, proc.pid);

  // exit / kill / SIGINT all end here — the real kill.
  ctx.processes.registerResource(proc.pid, "realm", () => {
    server.close();
    destroyRealm();
  });

  // terminate() aborts with `signal ?? reason`; pass the same value on.
  const signal = ctx.processes.getSignal(proc.pid);
  // (An AbortSignal only ever aborts once, so no `once` option is needed.)
  signal.addEventListener("abort", () =>
    server.notifyAbort(String(signal.reason ?? "exit")),
  );

  return { server, port: channel.port2 };
}

function bootMessage(proc: Process, entry: string): BootMessage {
  return {
    t: "boot",
    v: PROTOCOL_VERSION,
    pid: proc.pid,
    path: proc.path,
    entry,
    args: proc.args,
  };
}

export function executeWorker(
  ctx: KernelContext,
  proc: Process,
  entry: string,
): void {
  const worker = new Worker(
    new URL("../../runtime/worker-entry.ts", import.meta.url),
    { type: "module", name: `${proc.path} [${proc.pid}]` },
  );

  const { port } = connectRealm(ctx, proc, () => worker.terminate());

  // Script failed to load or threw synchronously. main() rejections arrive
  // as `fault` messages through the server instead.
  worker.onerror = (e) => {
    e.preventDefault();
    faultProcess(ctx, proc.pid, new Error(e.message || "worker failed to load"), "main");
  };

  ctx.processes.setStatus(proc.pid, "running");
  worker.postMessage(bootMessage(proc, entry), [port]);
}

/** The page every iframe app boots in. BASE_URL keeps it right under a sub-path deploy. */
const APP_HOST = `${import.meta.env.BASE_URL}app-host.html`;

/**
 * An iframe process: the kernel makes its window FIRST and puts the iframe
 * in it for good — moving an iframe in the DOM reloads it. The app later
 * claims that window with `windows.create`.
 *
 * sandbox="allow-scripts" WITHOUT allow-same-origin: the app gets an opaque
 * origin, so it cannot reach the kernel's DOM, storage or cookies. The port
 * is its only way out.
 */
export function executeIframe(
  ctx: KernelContext,
  proc: Process,
  entry: string,
  window: WindowOptions,
): void {
  const record = ctx.windows.createWindow(window, proc.pid);
  proc.surface = { windowId: record.id, claimed: false };

  const iframe = document.createElement("iframe");
  iframe.className = "app-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = window.title;
  iframe.src = APP_HOST; // before appending: no extra about:blank load

  // Removing the iframe unloads its document: that IS the kill. (The window
  // is destroyed by teardown too; remove() on a detached node is harmless.)
  const { port } = connectRealm(ctx, proc, () => iframe.remove());

  iframe.addEventListener(
    "load",
    () => {
      // "*" is required: a sandboxed frame's origin is "null" and cannot be
      // targeted. Safe — we post to this exact frame's window object.
      iframe.contentWindow?.postMessage(bootMessage(proc, entry), "*", [port]);
    },
    { once: true },
  );

  ctx.processes.setStatus(proc.pid, "running");
  record.bodyEl.appendChild(iframe);
  // The window was focused before the iframe existed; give it the keyboard now.
  iframe.focus();
}
