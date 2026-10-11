import { einval, eperm } from "../errors";
import { ADMIN_GID } from "../fs/perm";
import type { KernelContext, Pid } from "../types";
import { requireAlive } from "./guards";
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
 * The gid check only keeps visitors' programs from poking at it. It is NOT
 * the protection: the backend checks the session on every request.
 */
export function apiSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "apiFetch"> {
  return {
    apiFetch: async (callerPid: Pid, path: string, request?: ApiRequest) => {
      const proc = requireAlive(ctx, callerPid);
      if (proc.euid !== 0 && proc.gid !== ADMIN_GID) {
        throw eperm(callerPid, "api.fetch");
      }
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
