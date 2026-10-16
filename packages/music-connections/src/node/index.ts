/**
 * `music-connections/node`: the Node-only half of the SSRF rules, the
 * pinned transport. On every outbound request:
 *
 *   1. The URL passes the host gate (isAllowedRemote).
 *   2. The host is resolved once and every address it resolves to passes
 *      checkResolvedAddresses. The connection then goes to that exact address
 *      (a pinned lookup on a fresh socket; the Host header and the TLS server
 *      name stay the URL's), so DNS rebinding cannot swap the target after
 *      the check.
 *   3. No redirect is followed: a 3xx answer is a LinkError.
 *   4. A timeout on every request (REMOTE_TIMEOUT_MS unless told otherwise).
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { LinkError } from "../errors.js";
import { isAllowedRemote } from "../hosts.js";
import { bareHost, checkResolvedAddresses } from "../address.js";
import { REMOTE_TIMEOUT_MS } from "../limits.js";

/** Answers a host name with every address it resolves to. */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver (getaddrinfo), every answer in its own order. */
export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The one address a request to `url` connects to: the URL passes the host
 * gate, and every address its host resolves to passes the address rules.
 * Throws LinkError ('invalid url', 'remote not allowed', 'remote unresolvable',
 * 'address not allowed').
 */
export async function resolveTarget(url: string, trustedPublicHosts: readonly string[], resolver: Resolver = systemResolver): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LinkError("invalid url");
  }
  if (!isAllowedRemote(u.href, trustedPublicHosts)) throw new LinkError("remote not allowed");
  const host = bareHost(u.hostname);
  let ips: string[];
  if (isIP(host) !== 0) ips = [host];
  else {
    try {
      ips = await resolver(host);
    } catch {
      throw new LinkError("remote unresolvable");
    }
  }
  return checkResolvedAddresses(u, ips, trustedPublicHosts);
}

/** How a checked request reaches the network: `address` is the IP to connect to. */
export type Transport = (url: string, init: RequestInit & { signal: AbortSignal }, address: string) => Promise<Response>;

/** A lookup that answers every name with the one checked address. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address) === 6 ? 6 : 4;
  return ((_host: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => {
    if (typeof opts === "function") {
      (opts as (...a: unknown[]) => void)(null, address, family);
      return;
    }
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

/** node:http(s) to the pinned address, a fresh socket per request; no redirect is ever followed. */
export const nodeTransport: Transport = (url, init, address) => new Promise<Response>((resolve, reject) => {
  const u = new URL(url);
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : String(init.body);
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  const host = bareHost(u.hostname);
  const req = send({
    protocol: u.protocol,
    host,
    port: u.port || undefined,
    path: `${u.pathname}${u.search}`,
    method: init.method ?? "GET",
    headers,
    lookup: pinnedLookup(address),
    // a fresh socket per request: a pooled one could have been opened for another address
    agent: false,
    signal: init.signal,
    ...(u.protocol === "https:" && isIP(host) === 0 ? { servername: host } : {}),
  }, (res: IncomingMessage) => {
    const status = res.statusCode ?? 502;
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) h.append(k, x);
      else if (v !== undefined) h.set(k, v);
    }
    const noBody = status === 204 || status === 304 || (init.method ?? "GET") === "HEAD";
    if (noBody) res.resume();
    resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status: status < 200 || status > 599 ? 502 : status, headers: h }));
  });
  req.on("error", reject);
  req.end(body);
});

export interface PinnedFetchOptions {
  trustedPublicHosts: readonly string[];
  /** Sent as User-Agent: `<service>/<version> (music-connections/1)`. */
  userAgent: string;
  timeoutMs?: number;
  resolver?: Resolver;
  /** Tests: carry the checked request elsewhere. The URL and address checks still run first. */
  transport?: Transport;
}

/**
 * One outbound request: the URL and resolved-address checks, then the pinned
 * connection with the user agent and a timeout. A 3xx answer is refused
 * (LinkError 'redirect refused') and its body discarded.
 */
export async function pinnedFetch(url: string, init: RequestInit, opts: PinnedFetchOptions): Promise<Response> {
  const address = await resolveTarget(url, opts.trustedPublicHosts, opts.resolver);
  const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers)), "user-agent": opts.userAgent };
  const res = await (opts.transport ?? nodeTransport)(url, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_TIMEOUT_MS),
  }, address);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new LinkError("redirect refused");
  }
  return res;
}
