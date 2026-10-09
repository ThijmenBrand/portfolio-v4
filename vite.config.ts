import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Sandboxed iframe apps have an opaque origin, so the browser fetches their
 * module scripts (and CSS) with `Origin: null`. Allow that one origin, plus
 * Vite's default localhost ones, instead of disabling CORS altogether.
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

export default defineConfig({
  server: { cors },
  preview: { cors },
  // Workers use import.meta.glob (code-splitting), which IIFE output can't do.
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: {
        main: root("index.html"),
        // The page every iframe app boots in (src/kernel/proc/realm.ts).
        appHost: root("app-host.html"),
      },
    },
  },
});
