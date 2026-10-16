/**
 * Outbound Music Connections HTTP (tagave as a client): one fetch for the
 * linking routes (api) and the pull job (worker). The SSRF rules, on every
 * request (manifest, register, token, revoke, every feed page):
 *
 *   1. The URL passes the client host gate (allowlist.ts › isAllowedRemote):
 *      http(s) to a private or loopback IP literal, `localhost` or a DNS
 *      name (a LAN or Docker service name), or https to a host named in
 *      MC_TRUSTED_PUBLIC_HOSTS. Callers only pass URLs pinned to
 *      the linked remote's origin (scheme, host and the port it names): the
 *      manifest is refused when any endpoint it names sits elsewhere, so a
 *      token or a client secret never travels to another host.
 *   2. The host is resolved once and every address it resolves to must pass
 *      address.ts (link-local, 0/8, multicast, broadcast, `::` and mapped
 *      forms always refused; loopback only for a literally loopback host).
 *      An untrusted name may reach private addresses only, never loopback or
 *      a public one. The connection then goes to that exact address (a
 *      pinned lookup on a fresh socket; Host header and TLS server name stay
 *      the URL's), so DNS rebinding cannot swap the target after the check.
 *   3. No redirects: a 3xx answer is an error.
 *   4. A timeout (10 s, 30 s for a feed page) and a cap on every body read
 *      (64 KB, 5 MB for a feed page in the package's pull()).
 *   5. `User-Agent: tagave/<version> (music-connections/1)`.
 *
 * LinkError messages are fixed strings for the server log and a link's
 * last_error: never a token, a secret or a remote's body. The person adding
 * an address sees only a generic "could not reach" (api › mcConnections.ts).
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { ManifestSchema, isCapability, type Capability, type Manifest } from 'music-connections';
import { readBuildInfo } from '../build/info.js';
import { isAllowedRemote, parseTrustedHosts } from './allowlist.js';
import { addressAllowed, bareHost } from './address.js';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const REMOTE_TIMEOUT_MS = 10_000;
export const FEED_TIMEOUT_MS = 30_000;

/** Error whose message is safe to log (never a token or a remote's body). */
export class LinkError extends Error {
  override name = 'LinkError';
}

/** MC_TRUSTED_PUBLIC_HOSTS, read per call so a restart (or a test) can change it. */
export const trustedHosts = (): string[] => parseTrustedHosts(process.env['MC_TRUSTED_PUBLIC_HOSTS']);

// ── Resolution and the address check ──────────────────────────────────────

export type Resolver = (hostname: string) => Promise<string[]>;
const systemResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = systemResolver;
/** Tests: answer DNS with `r` (undefined restores the system resolver). */
export function setResolver(r: Resolver | undefined): void {
  resolver = r ?? systemResolver;
}

/**
 * The one address a request to `url` connects to: the URL passes the host
 * allow-list, and every address its host resolves to passes the address
 * rules. Throws LinkError.
 */
export async function resolveTarget(url: string, trusted: readonly string[] = trustedHosts()): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LinkError('invalid url');
  }
  if (!isAllowedRemote(u.href, trusted)) throw new LinkError('remote not allowed');
  const host = bareHost(u.hostname);
  const trustedName = u.protocol === 'https:' && isIP(host) === 0 && trusted.includes(host.toLowerCase());
  let ips: string[];
  if (isIP(host) !== 0) ips = [host];
  else {
    try {
      ips = await resolver(host);
    } catch {
      throw new LinkError('remote unresolvable');
    }
  }
  if (ips.length === 0) throw new LinkError('remote unresolvable');
  for (const ip of ips) if (!addressAllowed(host, ip, trustedName)) throw new LinkError('address not allowed');
  return ips[0]!;
}

// ── Transport ─────────────────────────────────────────────────────────────

/** How a checked request reaches the network: `address` is the IP to connect to. */
export type Transport = (url: string, init: RequestInit & { signal: AbortSignal }, address: string) => Promise<Response>;

/** A lookup that answers every name with the one checked address. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address) === 6 ? 6 : 4;
  return ((_host: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => {
    if (typeof opts === 'function') {
      (opts as (...a: unknown[]) => void)(null, address, family);
      return;
    }
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

/** node:http(s) to the pinned address; no redirect is ever followed (http.request follows none). */
const nodeTransport: Transport = (url, init, address) => new Promise<Response>((resolve, reject) => {
  const u = new URL(url);
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = typeof init.body === 'string' ? init.body : init.body == null ? undefined : String(init.body);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const host = bareHost(u.hostname);
  const req = send({
    protocol: u.protocol,
    host,
    port: u.port || undefined,
    path: `${u.pathname}${u.search}`,
    method: init.method ?? 'GET',
    headers,
    lookup: pinnedLookup(address),
    // a fresh socket per request: a pooled one could have been opened for another address
    agent: false,
    signal: init.signal,
    ...(u.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
  }, (res: IncomingMessage) => {
    const status = res.statusCode ?? 502;
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) h.append(k, x);
      else if (v !== undefined) h.set(k, v);
    }
    const noBody = status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD';
    if (noBody) res.resume();
    resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status: status < 200 || status > 599 ? 502 : status, headers: h }));
  });
  req.on('error', reject);
  req.end(body);
});

let transport: Transport = nodeTransport;
/**
 * Tests: carry checked requests with `t` instead of the network (undefined
 * restores it). The URL and address checks still run first.
 */
export function setRemoteFetch(t: ((url: string, init?: RequestInit) => Promise<Response>) | undefined): void {
  transport = t ? (url, init) => t(url, init) : nodeTransport;
}

let userAgent: string | null = null;
/** Sent on every outbound Music Connections request. */
export function mcUserAgent(): string {
  userAgent ??= `tagave/${readBuildInfo().version} (music-connections/1)`;
  return userAgent;
}

/**
 * One outbound request: the URL and resolved-address checks, then the
 * pinned connection, the user agent and a timeout. A 3xx is refused.
 */
export async function rfetch(url: string, init: RequestInit = {}, opts: { timeoutMs?: number } = {}): Promise<Response> {
  const address = await resolveTarget(url);
  const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers)), 'user-agent': mcUserAgent() };
  const res = await transport(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_TIMEOUT_MS) }, address);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new LinkError('redirect refused');
  }
  return res;
}

/** A body read incrementally, refused past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new LinkError('response too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await reader.read();
    } catch (err) {
      // the remote sent headers and then broke off (reset, timeout): never an unexpected error
      throw new LinkError(networkReason(err, 'response unreadable'));
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new LinkError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A small JSON answer (token, registration): capped at 64 KB; not JSON reads as {}. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await readCapped(res, MAX_MANIFEST_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/**
 * A manifest-supplied URL (absolute, or a path) resolved against the
 * remote's origin. It must stay on that origin and pass the allow-list.
 */
export function pinned(u: string, origin: string, trusted: readonly string[] = trustedHosts()): string {
  let r: URL;
  try {
    r = new URL(u, origin);
  } catch {
    throw new LinkError('endpoint invalid');
  }
  if (r.origin !== origin) throw new LinkError('endpoint on another host');
  if (!isAllowedRemote(r.href, trusted)) throw new LinkError('endpoint not allowed');
  return r.href;
}

export interface RemoteEndpoints {
  authorize: string;
  token: string;
  register: string;
  /** Each capability the remote provides, resolved and pinned. */
  feeds: Partial<Record<Capability, string>>;
}

/**
 * Every endpoint a manifest names, pinned to `origin`: the three auth
 * endpoints and every feed it provides (not only those tagave reads). One
 * that points elsewhere refuses the whole manifest.
 */
export function endpointsOf(manifest: Manifest, origin: string, trusted: readonly string[] = trustedHosts()): RemoteEndpoints {
  const feeds: Partial<Record<Capability, string>> = {};
  for (const [cap, url] of Object.entries(manifest.provides)) {
    if (isCapability(cap) && typeof url === 'string') feeds[cap] = pinned(url, origin, trusted);
  }
  return {
    authorize: pinned(manifest.auth.authorize, origin, trusted),
    token: pinned(manifest.auth.token, origin, trusted),
    register: pinned(manifest.auth.register, origin, trusted),
    feeds,
  };
}

/** A link's base: the origin of what the person typed, if it passes the allow-list. */
export function remoteOrigin(rawUrl: string, trusted: readonly string[] = trustedHosts()): string {
  let base: URL;
  try {
    base = new URL(rawUrl.trim());
  } catch {
    throw new LinkError('invalid url');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new LinkError('invalid url');
  if (base.username || base.password) throw new LinkError('invalid url');
  if (!isAllowedRemote(`${base.origin}/`, trusted)) throw new LinkError('remote not allowed');
  return base.origin;
}

export interface FetchedManifest {
  origin: string;
  manifest: Manifest;
  endpoints: RemoteEndpoints;
}

/**
 * Validate a remote base URL against the allow-list, fetch its manifest
 * from `<origin>/.well-known/music-connections` (64 KB cap, no redirects,
 * 10 s), validate it, and pin every endpoint it names to that origin.
 * Throws LinkError with a log-safe reason.
 */
export async function fetchRemoteManifest(rawUrl: string, trusted: readonly string[] = trustedHosts()): Promise<FetchedManifest> {
  const origin = remoteOrigin(rawUrl, trusted);
  let res: Response;
  try {
    res = await rfetch(`${origin}/.well-known/music-connections`, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new LinkError(networkReason(err, 'manifest unreachable'));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new LinkError(`manifest HTTP ${res.status}`);
  }
  let json: unknown;
  const text = await readCapped(res, MAX_MANIFEST_BYTES);
  try {
    json = JSON.parse(text);
  } catch {
    throw new LinkError('manifest not json');
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) throw new LinkError('manifest invalid');
  const manifest = parsed.data;
  const endpoints = endpointsOf(manifest, origin, trusted);
  return { origin, manifest, endpoints };
}

/** A fixed message for a failed fetch: timeout, network, or `fallback`. */
export function networkReason(err: unknown, fallback: string): string {
  if (err instanceof LinkError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'remote timed out';
    if (err.name === 'TypeError') return 'remote unreachable';
  }
  return fallback;
}

/** RFC 7009 endpoint next to the token endpoint (`…/token` → `…/revoke`), or null. */
export function revokeUrlFor(tokenUrl: string, origin: string, trusted: readonly string[] = trustedHosts()): string | null {
  let u: URL;
  try {
    u = new URL(pinned(tokenUrl, origin, trusted));
  } catch {
    return null;
  }
  if (!/\/token$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/token$/, '/revoke');
  u.search = '';
  return u.origin === origin && isAllowedRemote(u.href, trusted) ? u.href : null;
}

/**
 * Best-effort RFC 7009 revoke of a link's tokens at the remote that issued
 * them. Never throws. `tokens` must come from the same row as `remoteUrl`
 * and `manifest`, so tokens only ever go back to their issuer.
 */
export async function revokeAtRemote(
  link: { remoteUrl: string; manifest: unknown; clientId: string },
  tokens: { access_token?: string; refresh_token?: string; client_secret?: string },
): Promise<void> {
  try {
    const token = tokens.refresh_token || tokens.access_token || '';
    if (!token) return;
    const manifest = ManifestSchema.parse(link.manifest);
    const url = revokeUrlFor(manifest.auth.token, new URL(link.remoteUrl).origin);
    if (!url) return;
    const res = await rfetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: link.clientId, client_secret: tokens.client_secret ?? '' }).toString(),
    });
    await res.body?.cancel().catch(() => undefined);
  } catch {
    /* best effort */
  }
}
