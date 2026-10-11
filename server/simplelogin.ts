// SimpleLogin proxy for the Aliases app. The API key never leaves the server,
// and only the calls in slRoute are forwarded — never an arbitrary path.
import { HttpError } from "./auth.ts";

const BASE = "https://app.simplelogin.io";
const FILTERS = new Set(["enabled", "disabled", "pinned"]);

export interface SlRoute {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

/** Map an app request under /api/private/sl/ to a SimpleLogin call, or null. */
export function slRoute(method: string | undefined, pathname: string, params: URLSearchParams): SlRoute | null {
  const rest = pathname.slice("/api/private/sl".length);
  const pageParam = params.get("page") ?? "0";
  if (!/^\d{1,5}$/.test(pageParam)) return null;
  const page = Number(pageParam);

  if (method === "GET" && rest === "/aliases") {
    const filter = params.get("filter");
    if (filter && !FILTERS.has(filter)) return null;
    const path = `/api/v2/aliases?page_id=${page}${filter ? `&${filter}` : ""}`;
    const q = params.get("q")?.trim().slice(0, 200);
    // SimpleLogin takes the search query as a POST body on the same list endpoint.
    return q ? { method: "POST", path, body: { query: q } } : { method: "GET", path };
  }

  let m = /^\/aliases\/(\d{1,12})\/toggle$/.exec(rest);
  if (method === "POST" && m) return { method: "POST", path: `/api/aliases/${m[1]}/toggle` };

  m = /^\/aliases\/(\d{1,12})\/contacts$/.exec(rest);
  if (method === "GET" && m) return { method: "GET", path: `/api/aliases/${m[1]}/contacts?page_id=${page}` };

  m = /^\/contacts\/(\d{1,12})\/toggle$/.exec(rest);
  if (method === "POST" && m) return { method: "POST", path: `/api/contacts/${m[1]}/toggle` };

  return null;
}

export async function callSimpleLogin(route: SlRoute): Promise<{ status: number; body: unknown }> {
  // Read lazily: a missing key disables this app, not the whole API.
  const key = process.env.SIMPLELOGIN_API_KEY;
  if (!key) throw new HttpError(503, "SIMPLELOGIN_API_KEY is not set on the server");

  let response: Response;
  try {
    response = await fetch(BASE + route.path, {
      method: route.method,
      headers: { Authentication: key, ...(route.body ? { "Content-Type": "application/json" } : {}) },
      body: route.body ? JSON.stringify(route.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, "SimpleLogin is unreachable");
  }
  // A 401 here means a bad key, not a bad session: don't let the OS read it as logged out.
  if (response.status === 401) throw new HttpError(502, "SimpleLogin rejected the API key");
  const body: unknown = await response.json().catch(() => ({ error: `SimpleLogin answered ${response.status}` }));
  return { status: response.status, body };
}
