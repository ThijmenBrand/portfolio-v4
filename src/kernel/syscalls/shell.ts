import { einval } from "../errors";
import type { KernelContext, Pid } from "../types";
import { alive } from "./guards";
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
): Pick<SyscallTable, "openExternal"> {
  return {
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
  };
}
