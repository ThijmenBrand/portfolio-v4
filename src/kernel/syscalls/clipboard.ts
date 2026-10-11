import { einval, eperm } from "../errors";
import type { KernelContext, Pid } from "../types";
import { alive } from "./guards";
import type { SyscallTable } from "./table";

const MAX_TEXT = 1 << 20; // 1 MiB of text is plenty for copy/paste

/**
 * Text clipboard, done by the kernel's page on an app's behalf. Realms are
 * opaque-origin sandboxed frames, so their own navigator.clipboard is
 * unreliable for writing and unusable for reading.
 *
 * The kernel also keeps its own copy, so copy/paste between apps works even
 * when the browser refuses the system clipboard. `synced` says whether that
 * copy also reached the system clipboard; if not, the system one is stale.
 */
export function clipboardSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "clipboardWrite" | "clipboardRead"> {
  let buffer = { text: "", synced: false };

  return {
    clipboardWrite: alive(ctx, async (_pid: Pid, text: string) => {
      const value = String(text);
      if (value.length > MAX_TEXT) {
        throw einval(`clipboard.writeText: text over ${MAX_TEXT} chars`);
      }
      const entry = { text: value, synced: false };
      buffer = entry;
      try {
        await navigator.clipboard.writeText(value);
        entry.synced = true;
      } catch {
        // ponytail: denied or unfocused; the kernel copy still serves apps.
      }
    }),
    /**
     * Reading needs a recent click or keypress: one inside an app's iframe
     * activates the kernel's page too (see shell.ts). That stops a
     * background app or worker from snooping on the clipboard.
     */
    clipboardRead: alive(ctx, async (pid: Pid): Promise<string> => {
      if (!navigator.userActivation?.isActive) {
        throw eperm(pid, "clipboard.readText");
      }
      if (!buffer.synced && buffer.text) return buffer.text;
      try {
        return await navigator.clipboard.readText();
      } catch {
        return buffer.text;
      }
    }),
  };
}
