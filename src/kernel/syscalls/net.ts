import { einval, eio, eperm } from "../errors";
import { ADMIN_GID } from "../fs/perm";
import type { Bytes, KernelContext, Pid } from "../types";
import { requireAlive } from "./guards";
import type { SyscallTable } from "./table";

export interface NetRequest {
  method?: "GET" | "HEAD" | "POST";
  body?: string;
  contentType?: string;
}

export interface NetResponse {
  status: number;
  contentType: string;
  body: Bytes;
}

/**
 * The network: an https request to anywhere on the internet.
 *
 * The browser can't do this for a realm (CSP, and CORS on most sites), so the
 * kernel hands it to the backend's /api/private/net/fetch, which makes the
 * request and refuses private addresses (server/net.ts). Owner only: the gid
 * check keeps visitors' programs out, the backend's session check is the real
 * gate. No cookies or caller headers go along; only the body and its type
 * come back.
 */
export function netSyscalls(
  ctx: KernelContext,
): Pick<SyscallTable, "netFetch"> {
  return {
    netFetch: async (callerPid: Pid, url: string, request?: NetRequest) => {
      const proc = requireAlive(ctx, callerPid);
      if (proc.euid !== 0 && proc.gid !== ADMIN_GID) {
        throw eperm(callerPid, "net.fetch");
      }
      let target: URL;
      try {
        target = new URL(String(url));
      } catch {
        throw einval(`net.fetch: not a URL: ${String(url).slice(0, 200)}`);
      }
      if (target.protocol !== "https:") {
        throw einval(`net.fetch: only https: ${target.protocol}`);
      }

      const response = await fetch("/api/private/net/fetch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: target.href,
          method: request?.method,
          body: request?.body,
          contentType: request?.contentType,
        }),
        signal: proc.abortController.signal,
      });
      const status = response.headers.get("X-Net-Status");
      if (status === null) {
        if (response.status === 401) throw eperm(callerPid, "net.fetch");
        const { error } = await response.json().catch(() => ({ error: "" }));
        throw eio(`net.fetch ${target.host}: ${error || response.status}`);
      }
      return {
        status: Number(status),
        contentType: response.headers.get("X-Net-Content-Type") ?? "",
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}
