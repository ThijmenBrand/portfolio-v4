import { einval, eperm } from "../errors";
import type { KernelContext, Pid, Process } from "../types";
import { requireAlive, requirePrivilege } from "./guards";
import type { SyscallTable } from "./table";

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
}

export interface ApiResponse {
  status: number;
  body: string;
}

/**
 * The OS's own backend (server/), same origin under /api/.
 *
 * Realms can't fetch: their CSP is `connect-src 'none'` and their origin is
 * opaque, so they'd have no cookie anyway. The kernel page makes the request
 * for them and the session cookie goes along.
 *
 * Who may ask. The browser holds one cookie, so this is not "may you read
 * your own data" but "are you the one who signed in": any program the kernel
 * fetches for borrows that session. Hence the real uid rather than the
 * effective one or the group -- root is a well-known password away
 * (bin/lib/users.ts), and `su root` replaces the real uid while `sudo` keeps
 * it. Code out of the VFS is refused outright; it keeps net.fetch.
 *
 * It is still not THE protection: the backend checks the session on every
 * request. It stops a visitor spending the owner's session from in here.
 */
function mayReachBackend(ctx: KernelContext, proc: Process): boolean {
  if (proc.untrusted) return false;
  // login itself, which has to be able to authenticate before anyone is.
  if (proc.privileged) return true;
  const owner = ctx.fs.session;
  return owner !== undefined && proc.uid === owner;
}
export function apiSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "apiFetch" | "setSessionUser"> {
  return {
    /** Privileged: login says who signed in, and clears it on sign-out. */
    setSessionUser: async (callerPid: Pid, uid: number | undefined) => {
      requirePrivilege(ctx, callerPid, "api.bindSession");
      ctx.fs.setSessionUid(uid);
    },
    apiFetch: async (callerPid: Pid, path: string, request?: ApiRequest) => {
      const proc = requireAlive(ctx, callerPid);
      if (!mayReachBackend(ctx, proc)) throw eperm(callerPid, "api.fetch");
      const url = new URL(String(path), window.location.origin);
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith("/api/")
      ) {
        throw einval(
          `api.fetch: not an /api/ path: ${String(path).slice(0, 200)}`,
        );
      }

      const method = request?.method ?? "GET";
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: method === "GET" ? {} : { "Content-Type": "application/json" },
        body: request?.body,
        signal: proc.abortController.signal,
      });
      return { status: response.status, body: await response.text() };
    },
  };
}
