import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Sandboxed realms (iframe apps and the workers' host frames) have an opaque
 * origin, so the browser fetches their module scripts (and CSS) with
 * `Origin: null`. Allow that one origin, plus Vite's default localhost ones,
 * instead of disabling CORS altogether.
 *
 * This only covers `vite` and `vite preview`. The production host must send
 * `Access-Control-Allow-Origin` on /assets/* itself.
 */
const cors = {
  origin: [
    /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
    "null",
  ],
};

/**
 * Content-Security-Policy for the realm host pages. Apps reach the outside
 * world ONLY through the kernel port: no fetch/XHR/WebSocket, no external
 * images, frames, forms or plugins. A worker started from a blob URL inherits
 * its creator's policy, so worker programs are covered by worker-host's CSP.
 *
 * Injected as <meta> so it ships with the page on any static host.
 */
function realmCsp(): Plugin {
  const hosts = /(?:^|\/)(app-host|worker-host)\.html$/;
  return {
    name: "realm-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = hosts.exec(ctx.filename)?.[1];
        if (!page) return html;
        const dev = ctx.server !== undefined;
        const policy = [
          "default-src 'none'",
          "script-src 'self'",
          // worker-host builds its worker from a blob: URL; app iframes get none.
          `worker-src ${page === "worker-host" ? "data:" : "'none'"}`,
          // Dev only: Vite's HMR client needs its websocket + ping.
          `connect-src ${dev ? "'self' ws: wss:" : "'none'"}`,
          // Vite injects CSS as <style> in dev; app-host has an inline <style>.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "media-src 'self' data: blob:",
          "object-src 'none'",
          "frame-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: policy },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  plugins: [realmCsp()],
  server: { cors },
  preview: { cors },
  // Workers use import.meta.glob (code-splitting), which IIFE output can't do.
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        main: root("index.html"),
        // The pages every realm boots in (src/kernel/proc/realm.ts).
        appHost: root("app-host.html"),
        workerHost: root("worker-host.html"),
      },
    },
  },
});
