/**
 * Outbound Music Connections HTTP (tagave as a client): one fetch for the
 * linking routes (api) and the pull job (worker).
 *
 * Every request:
 *   - goes only to a URL on the linked remote's own origin that passes the
 *     allow-list (allowlist.ts). The remote's manifest names its auth
 *     endpoints and feeds; every one of them must sit on the origin the
 *     person typed, or the manifest is refused, so a token or a client
 *     secret never travels to another host;
 *   - follows no redirect (redirect: 'error');
 *   - gives up after 10 s;
 *   - reads at most 64 KB of anything but a feed page (the package's pull()
 *     caps those at 5 MB);
 *   - says who it is: `User-Agent: tagave/<version> (music-connections/1)`.
 *
 * LinkError messages are fixed strings, safe for logs and for the link's
 * last_error: never a token, a secret or a response body.
 */
import { ManifestSchema, isCapability, type Capability, type Manifest } from 'music-connections';
import { readBuildInfo } from '../build/info.js';
import { isAllowedRedirect, parseTrustedHosts } from './allowlist.js';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const REMOTE_TIMEOUT_MS = 10_000;

/** Error whose message is safe to log and to show (never a token or a remote's body). */
export class LinkError extends Error {
  override name = 'LinkError';
}

// Injectable for tests (no live network calls); production uses global fetch.
let remoteFetch: typeof fetch = (...a) => fetch(...a);
/** Tests: route every outbound Music Connections request through `f` (undefined restores fetch). */
export function setRemoteFetch(f: typeof fetch | undefined): void {
  remoteFetch = f ?? ((...a) => fetch(...a));
}

/** MC_TRUSTED_PUBLIC_HOSTS, read per call so a restart (or a test) can change it. */
export const trustedHosts = (): string[] => parseTrustedHosts(process.env['MC_TRUSTED_PUBLIC_HOSTS']);

let userAgent: string | null = null;
/** Sent on every outbound Music Connections request. */
export function mcUserAgent(): string {
  userAgent ??= `tagave/${readBuildInfo().version} (music-connections/1)`;
  return userAgent;
}

/** fetch with the user agent, no redirects and a timeout. `url` must already be checked (pinned). */
export function rfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init.headers)), 'user-agent': mcUserAgent() };
  return remoteFetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
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
    const { done, value } = await reader.read();
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
  if (!isAllowedRedirect(r.href, trusted)) throw new LinkError('endpoint not allowed');
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
  if (!isAllowedRedirect(`${base.origin}/`, trusted)) throw new LinkError('remote not allowed');
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
  return u.origin === origin && isAllowedRedirect(u.href, trusted) ? u.href : null;
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
