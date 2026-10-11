// The OS's network card: kernel net.fetch -> here -> the internet. Owner only
// (main.ts checks the session). https on port 443 only, and never to a private
// address: the check runs in the socket's own DNS lookup, so a hostname can't
// pass it and then resolve somewhere else (DNS rebinding). Redirects included.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { HttpError } from "./auth.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METHODS = new Set(["GET", "HEAD", "POST"]);

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3], // 224/3: multicast + reserved + broadcast
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6"); // ::/127 = unspecified + loopback
}

/** Loopback, LAN, link-local, Docker's network…: anywhere the internet isn't. */
export function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPrivate(mapped);
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Same shape as dns.lookup, so https.request can use it for every connection.
const guardedLookup = ((
  hostname: string,
  options: { all?: boolean },
  callback: Function,
) => {
  dnsLookup(
    hostname,
    { ...options, all: true },
    (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => isPrivate(a.address));
      if (bad)
        return callback(
          new HttpError(403, `refusing private address for ${hostname}`),
        );
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    },
  );
}) as unknown as typeof dnsLookup;

export interface NetRequest {
  url: string;
  method?: string;
  body?: string;
  contentType?: string;
}

export interface NetResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function checkUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password
  ) {
    throw new HttpError(400, "only https URLs on port 443");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivate(host))
    throw new HttpError(403, `refusing private address ${host}`);
  return url;
}

function once(url: URL, req: NetRequest, method: string, signal: AbortSignal) {
  return new Promise<NetResponse & { location?: string }>((resolve, reject) => {
    const out = request(
      url,
      {
        method,
        lookup: guardedLookup,
        signal,
        headers: {
          "User-Agent": "thijmenbrand.nl-os",
          Accept: "*/*",
          ...(req.body !== undefined
            ? { "Content-Type": req.contentType ?? "text/plain" }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new HttpError(502, "response too large"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            contentType: res.headers["content-type"] ?? "",
            body: Buffer.concat(chunks),
            location: res.headers.location,
          }),
        );
        res.on("error", reject);
      },
    );
    out.on("error", reject);
    out.end(req.body);
  });
}

export async function netFetch(req: NetRequest): Promise<NetResponse> {
  let method = (req.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new HttpError(400, "method not allowed");
  if (req.body !== undefined && method !== "POST")
    throw new HttpError(400, "body only with POST");
  let url = checkUrl(req.url);
  const signal = AbortSignal.timeout(10_000);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await once(url, req, method, signal);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `${url.hostname} is unreachable`);
    }
    if (res.status < 300 || res.status >= 400 || !res.location) {
      return {
        status: res.status,
        contentType: res.contentType,
        body: res.body,
      };
    }
    if (hop >= MAX_REDIRECTS) throw new HttpError(502, "too many redirects");
    url = checkUrl(new URL(res.location, url).href);
    // Like browsers: 301/302/303 after a POST continue as a GET without the body.
    if (res.status !== 307 && res.status !== 308 && method === "POST") {
      method = "GET";
      req = { ...req, body: undefined };
    }
  }
}
