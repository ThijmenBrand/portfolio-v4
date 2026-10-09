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

/** Realm host pages. BASE_URL keeps them right under a sub-path deploy. */
const APP_HOST = `${import.meta.env.BASE_URL}app-host.html`;
const WORKER_HOST = `${import.meta.env.BASE_URL}worker-host.html`;

/**
 * Every realm lives in a sandboxed iframe: opaque origin, so no access to the
 * kernel's DOM, cookies, OPFS (/home) or IndexedDB, and the CSP on the host
 * page (vite.config.ts) blocks network access. Removing the iframe is the kill.
 */
function sandboxedFrame(src: string, title: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = title;
  iframe.src = src; // before appending: no extra about:blank load
  return iframe;
}

/**
 * A realm document must stay the one we loaded. A sandboxed frame can still
 * navigate ITSELF (e.g. to leak data in a URL); CSP can't prevent that, but a
 * second `load` reveals it, and we end the process.
 */
function watchNavigation(ctx: KernelContext, proc: Process, iframe: HTMLIFrameElement): void {
  let loads = 0;
  iframe.addEventListener("load", () => {
    if (++loads > 1) {
      faultProcess(ctx, proc.pid, new Error("realm navigated away from its host page"), "main");
    }
  });
}

/** Invisible, but not display:none — keep the frame a normal, running document. */
function realmLayer(): HTMLElement {
  let layer = document.getElementById("realm-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "realm-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText =
      "position:fixed;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * A worker process: an invisible sandboxed iframe (worker-host.html) that
 * starts the worker, so the worker inherits the frame's opaque origin and CSP.
 * A worker created straight from the kernel's page would share the kernel's
 * origin — and could open OPFS and IndexedDB directly, around the VFS.
 */
export function executeWorker(
  ctx: KernelContext,
  proc: Process,
  entry: string,
): void {
  const iframe = sandboxedFrame(WORKER_HOST, `${proc.path} [${proc.pid}]`);

  // The host reports a worker that fails to load (the port is inside the
  // worker by then). Accept it only from THIS frame.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as { t?: unknown; message?: unknown } | null;
    if (data?.t !== "realm-error") return;
    const message = typeof data.message === "string" ? data.message : "worker failed to load";
    faultProcess(ctx, proc.pid, new Error(message.slice(0, 500)), "main");
  };
  window.addEventListener("message", onMessage);

  // Removing the frame terminates the worker it created.
  const { port } = connectRealm(ctx, proc, () => {
    window.removeEventListener("message", onMessage);
    iframe.remove();
  });

  iframe.addEventListener(
    "load",
    () => iframe.contentWindow?.postMessage(bootMessage(proc, entry), "*", [port]),
    { once: true },
  );
  watchNavigation(ctx, proc, iframe);

  ctx.processes.setStatus(proc.pid, "running");
  realmLayer().appendChild(iframe);
}


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

  const iframe = sandboxedFrame(APP_HOST, window.title);
  iframe.className = "app-frame";

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
  watchNavigation(ctx, proc, iframe);

  ctx.processes.setStatus(proc.pid, "running");
  record.bodyEl.appendChild(iframe);
  // The window was focused before the iframe existed; give it the keyboard now.
  iframe.focus();
}
