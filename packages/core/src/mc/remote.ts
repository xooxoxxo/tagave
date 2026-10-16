/**
 * Outbound Music Connections HTTP (tagave as a client): one fetch for the
 * linking routes (api) and the pull job (worker). The SSRF rules are the
 * protocol's, from the music-connections package; this file is tagave's glue
 * (its trusted-hosts setting, user agent, test hooks and log-safe reasons).
 * On every request (manifest, register, token, revoke, every feed page):
 *
 *   1. The URL passes the client host gate (isAllowedRemote). Callers only
 *      pass URLs pinned to the linked remote's origin: the manifest is
 *      refused when any endpoint it names sits elsewhere (endpointsOf), so a
 *      token or a client secret never travels to another host.
 *   2. The host is resolved once and every address it resolves to must pass
 *      the address rules; the connection then goes to that exact address
 *      (music-connections/node › pinnedFetch), so DNS rebinding cannot swap
 *      the target after the check.
 *   3. No redirects: a 3xx answer is an error.
 *   4. A timeout (10 s, 30 s for a feed page) and a cap on every body read
 *      (64 KB, 5 MB for a feed page in the package's pull()).
 *   5. `User-Agent: tagave/<version> (music-connections/1)`.
 *
 * LinkError messages are fixed strings for the server log and a link's
 * last_error: never a token, a secret or a remote's body. The person adding
 * an address sees only a generic "could not reach" (api › mcConnections.ts).
 */
import {
  LinkError,
  MAX_MANIFEST_BYTES,
  ManifestSchema,
  endpointsOf as mcEndpointsOf,
  manifestUrl,
  networkReason,
  parseTrustedHosts,
  pinToOrigin,
  readCapped,
  remoteOrigin as mcRemoteOrigin,
  revokeUrlFor as mcRevokeUrlFor,
  userAgentFor,
  type Manifest,
  type RemoteEndpoints,
} from 'music-connections';
import { nodeTransport, pinnedFetch, resolveTarget as mcResolveTarget, systemResolver, type Resolver, type Transport } from 'music-connections/node';
import { readBuildInfo } from '../build/info.js';

export { FEED_TIMEOUT_MS, LinkError, MAX_MANIFEST_BYTES, REMOTE_TIMEOUT_MS, networkReason, readCapped, type RemoteEndpoints } from 'music-connections';
export { pinnedLookup, type Resolver, type Transport } from 'music-connections/node';

/** MC_TRUSTED_PUBLIC_HOSTS, read per call so a restart (or a test) can change it. */
export const trustedHosts = (): string[] => parseTrustedHosts(process.env['MC_TRUSTED_PUBLIC_HOSTS']);

// ── Resolution and transport (test hooks) ─────────────────────────────────

let resolver: Resolver = systemResolver;
/** Tests: answer DNS with `r` (undefined restores the system resolver). */
export function setResolver(r: Resolver | undefined): void {
  resolver = r ?? systemResolver;
}

/** The one address a request to `url` connects to (host gate, then every resolved address). Throws LinkError. */
export function resolveTarget(url: string, trusted: readonly string[] = trustedHosts()): Promise<string> {
  return mcResolveTarget(url, trusted, resolver);
}

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
  userAgent ??= userAgentFor('tagave', readBuildInfo().version);
  return userAgent;
}

/**
 * One outbound request: the URL and resolved-address checks, then the
 * pinned connection, the user agent and a timeout. A 3xx is refused.
 */
export function rfetch(url: string, init: RequestInit = {}, opts: { timeoutMs?: number } = {}): Promise<Response> {
  return pinnedFetch(url, init, {
    trustedPublicHosts: trustedHosts(),
    userAgent: mcUserAgent(),
    resolver,
    transport,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
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

// ── Same origin (the package's rules, with tagave's trusted hosts) ─────────

/** A manifest-supplied URL resolved against the remote's origin; it must stay there and pass the allow-list. */
export const pinned = (u: string, origin: string, trusted: readonly string[] = trustedHosts()): string => pinToOrigin(u, origin, trusted);

/** Every endpoint a manifest names, pinned to `origin`; one elsewhere refuses the whole manifest. */
export const endpointsOf = (manifest: Manifest, origin: string, trusted: readonly string[] = trustedHosts()): RemoteEndpoints =>
  mcEndpointsOf(manifest, origin, trusted);

/** A link's base: the origin of what the person typed, if it passes the allow-list. */
export const remoteOrigin = (rawUrl: string, trusted: readonly string[] = trustedHosts()): string => mcRemoteOrigin(rawUrl, trusted);

/** RFC 7009 endpoint next to the token endpoint (`…/token` → `…/revoke`), or null. */
export const revokeUrlFor = (tokenUrl: string, origin: string, trusted: readonly string[] = trustedHosts()): string | null =>
  mcRevokeUrlFor(tokenUrl, origin, trusted);

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
    res = await rfetch(manifestUrl(origin), { headers: { accept: 'application/json' } });
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
