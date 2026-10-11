import { ebusy, einval } from "../errors";
import type { DialogOptions } from "../dialog/list";
import { showPicker } from "../dialog/picker";
import { resolveFrom } from "../fs/path";
import type { KernelContext, Pid } from "../types";
import { rejectOnThrow, requireAlive } from "./guards";
import type { SyscallTable } from "./table";

/**
 * OS dialogs any app can open. The kernel draws them (as a sheet over the
 * caller's window) and browses with the caller's credentials, so a picker
 * never shows more than the app could read itself.
 */
export function dialogSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "openDialog"> {
  const showing = new Set<Pid>();

  return {
    openDialog: (callerPid, options: DialogOptions) =>
      rejectOnThrow(async () => {
        const proc = requireAlive(ctx, callerPid);
        const kind = options?.kind;
        if (kind !== "file" && kind !== "directory")
          throw einval(`dialog.open: kind must be "file" or "directory"`);
        if (showing.has(callerPid)) throw ebusy("dialog");
        showing.add(callerPid);

        let resourceId = -1;
        try {
          const title =
            typeof options.title === "string"
              ? options.title.slice(0, 120)
              : undefined;
          let start = "/";
          try {
            const want = resolveFrom(
              proc.cwd,
              String(options.startIn ?? proc.env.HOME ?? "/"),
            );
            if ((await ctx.fs.stat(want, proc)).kind === "directory")
              start = want;
          } catch {
            // Unreadable or bogus startIn: fall back to the root.
          }

          const windowId = proc.surface?.windowId;
          const picker = showPicker(
            { kind, title },
            start,
            String(proc.env.HOME ?? "/"),
            {
              readdir: (path) => ctx.fs.readdir(path, proc),
              mkdir: (path) => ctx.fs.mkdir(path, proc),
            },
            windowId !== undefined
              ? (el) => ctx.windows.attachSheet(windowId, el)
              : (el) => {
                  // Worker apps have no window: float over the desktop.
                  el.classList.add("floating");
                  ctx.display.getWindowLayer().append(el);
                  el.focus();
                  return () => el.remove();
                },
          );
          resourceId = ctx.processes.registerResource(
            callerPid,
            "dialog",
            picker.cancel,
          );
          return await picker.result;
        } finally {
          showing.delete(callerPid);
          if (resourceId !== -1 && ctx.processes.get(callerPid))
            ctx.processes.unregisterResource(callerPid, resourceId);
        }
      }),
  };
}
