// Bundled worker entry, as a URL (Vite compiles it as a module worker).
import workerUrl from "./worker-entry.ts?worker&url";
import { isBoot } from "./boot";

/**
 * Runs in the invisible sandboxed iframe the kernel makes for each worker
 * process (src/kernel/proc/realm.ts). Its only job: start the worker and
 * hand it the boot message and the kernel port.
 *
 * Why the detour through a data: URL: an opaque-origin document may not
 * construct a Worker from an http(s) URL (that origin is never "same origin"
 * as null), and Chrome refuses blob: workers from a sandboxed frame too. A
 * data: worker always gets an opaque origin and inherits this page's CSP; it
 * then loads the real code with a CORS module import — the same way the
 * iframe apps load theirs.
 *
 * The bootstrap takes the boot message itself, imports the entry (which
 * installs its message handler), then re-delivers the message to it. A boot
 * arriving before the handler exists would otherwise be lost. And a dynamic
 * import's rejection carries the real load error — a module worker's `error`
 * event has no message at all. (No exports involved: Vite strips them from
 * worker bundles.)
 */
function bootstrapSource(entryUrl: string): string {
  return `
self.onmessage = (event) => {
  self.onmessage = null;
  const { data, ports } = event;
  import(${JSON.stringify(entryUrl)})
    .then(() => self.dispatchEvent(new MessageEvent("message", { data, ports: [...ports] })))
    .catch((error) =>
      self.postMessage({ t: "realm-error", message: String((error && error.message) || error) }),
    );
};`;
}

/** Tell the kernel. It accepts this only from our frame and only as a fault. */
function reportFailure(message: string): void {
  parent.postMessage({ t: "realm-error", message }, "*"); // parent's origin isn't ours to know
}

function startWorker(event: MessageEvent): void {
  if (event.source !== window.parent) return; // only our kernel
  const port = event.ports[0];
  if (!isBoot(event.data, port)) return;
  window.removeEventListener("message", startWorker); // boot exactly once

  const boot = event.data;
  const entryUrl = new URL(workerUrl, location.href).href;
  const bootstrap = `data:text/javascript;charset=utf-8,${encodeURIComponent(
    bootstrapSource(entryUrl),
  )}`;

  const worker = new Worker(bootstrap, {
    type: "module",
    name: `${boot.path} [${boot.pid}]`, // shows up in DevTools
  });
  worker.onmessage = (e: MessageEvent) => {
    if (e.data?.t === "realm-error") reportFailure(String(e.data.message));
  };
  worker.onerror = (e) => {
    e.preventDefault();
    reportFailure(e.message || "worker failed to load");
  };

  worker.postMessage(boot, [port]);
}

window.addEventListener("message", startWorker);
