import { einval } from "../errors";
import type { KernelContext, LocationInfo, Pid } from "../types";
import { basename, resolveFrom } from "../fs/path";
import { alive, requireAlive } from "./guards";
import type { SyscallTable } from "./table";

/** Schemes an app may ask the kernel to open. Nothing that runs code. */
const ALLOWED = new Set(["https:", "mailto:"]);

/**
 * Open a link outside the OS (a new browser tab, or the mail client).
 *
 * A sandboxed app can't do this itself: it has no popup permission, and
 * navigating its own frame is treated as an escape (realm.ts kills it). So
 * the kernel opens the link on its behalf — after checking the scheme.
 *
 * Abuse is bounded by the browser: a popup only opens with recent user
 * activation, and a click inside an app's iframe activates its ancestors
 * too. An app calling this without a real click just gets blocked silently.
 */
export function shellSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "openExternal" | "getLocation" | "download"> {
  return {
    /**
     * Read-only: a copy of the page URL, so programs can react to links like
     * ?launch=terminal. There is deliberately no way to change the URL.
     * Treat the result as untrusted input — whoever made the link chose it.
     */
    getLocation: alive(ctx, (): LocationInfo => {
      const { href, pathname, search, hash } = window.location;
      return { href, pathname, search, hash };
    }),
    openExternal: alive(ctx, (_pid: Pid, url: string) => {
      let target: URL;
      try {
        target = new URL(String(url));
      } catch {
        throw einval(`openExternal: not a URL: ${String(url).slice(0, 200)}`);
      }
      if (!ALLOWED.has(target.protocol)) {
        throw einval(`openExternal: scheme not allowed: ${target.protocol}`);
      }
      // noopener: the new tab gets no handle back to the kernel's window.
      window.open(target.href, "_blank", "noopener,noreferrer");
    }),
    /**
     * Hand a VFS file to the browser as a download. Realms can't (their
     * sandbox has no allow-downloads), so the kernel's page does it, with
     * the caller's own read permission. Bytes only: the type is fixed to
     * octet-stream, so nothing is ever rendered on our origin.
     */
    download: alive(ctx, async (pid: Pid, path: string) => {
      const proc = requireAlive(ctx, pid);
      const file = resolveFrom(proc.cwd, String(path));
      const bytes = await ctx.fs.readFile(file, proc.abortController.signal, proc);
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
      );
      const link = Object.assign(document.createElement("a"), {
        href: url,
        download: basename(file),
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }),
  };
}
