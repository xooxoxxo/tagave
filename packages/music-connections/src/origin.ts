/**
 * Same-origin rules for a remote's manifest: a client links to one origin
 * (scheme, host and port), fetches the manifest from it, and refuses the
 * whole manifest when any endpoint it names (the three auth endpoints and
 * every feed, not only those the client reads) sits elsewhere. So a token or
 * a client secret only ever travels back to the host that issued it.
 */
import { isCapability, type Capability } from "./capabilities.js";
import { LinkError } from "./errors.js";
import { isAllowedRemote } from "./hosts.js";
import type { Manifest } from "./schemas.js";

/** Where a service serves its manifest. */
export const MANIFEST_PATH = "/.well-known/music-connections";

/** The manifest URL of `origin`. */
export const manifestUrl = (origin: string): string => `${origin}${MANIFEST_PATH}`;

/**
 * A link's base: the origin of what the person typed, when it is an http(s)
 * URL without user info that passes isAllowedRemote. Throws LinkError
 * ('invalid url', 'remote not allowed').
 */
export function remoteOrigin(rawUrl: string, trustedPublicHosts: readonly string[]): string {
  let base: URL;
  try {
    base = new URL(rawUrl.trim());
  } catch {
    throw new LinkError("invalid url");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new LinkError("invalid url");
  if (base.username || base.password) throw new LinkError("invalid url");
  if (!isAllowedRemote(`${base.origin}/`, trustedPublicHosts)) throw new LinkError("remote not allowed");
  return base.origin;
}

/**
 * A manifest-supplied URL (absolute, or a path) resolved against `origin`.
 * It must stay on that origin and pass isAllowedRemote. Throws LinkError
 * ('endpoint invalid', 'endpoint on another host', 'endpoint not allowed').
 */
export function pinToOrigin(url: string, origin: string, trustedPublicHosts: readonly string[]): string {
  let r: URL;
  try {
    r = new URL(url, origin);
  } catch {
    throw new LinkError("endpoint invalid");
  }
  if (r.origin !== origin) throw new LinkError("endpoint on another host");
  if (!isAllowedRemote(r.href, trustedPublicHosts)) throw new LinkError("endpoint not allowed");
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
 * Every endpoint `manifest` names, pinned to `origin`. One that points
 * elsewhere refuses the whole manifest (LinkError).
 */
export function endpointsOf(manifest: Manifest, origin: string, trustedPublicHosts: readonly string[]): RemoteEndpoints {
  const feeds: Partial<Record<Capability, string>> = {};
  for (const [cap, url] of Object.entries(manifest.provides)) {
    if (isCapability(cap) && typeof url === "string") feeds[cap] = pinToOrigin(url, origin, trustedPublicHosts);
  }
  return {
    authorize: pinToOrigin(manifest.auth.authorize, origin, trustedPublicHosts),
    token: pinToOrigin(manifest.auth.token, origin, trustedPublicHosts),
    register: pinToOrigin(manifest.auth.register, origin, trustedPublicHosts),
    feeds,
  };
}

/**
 * The RFC 7009 endpoint next to the token endpoint (`…/token` → `…/revoke`),
 * pinned to `origin`, or null when the token URL does not end in `/token` or
 * is not on the origin.
 */
export function revokeUrlFor(tokenUrl: string, origin: string, trustedPublicHosts: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(pinToOrigin(tokenUrl, origin, trustedPublicHosts));
  } catch {
    return null;
  }
  if (!/\/token$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/token$/, "/revoke");
  u.search = "";
  return u.origin === origin && isAllowedRemote(u.href, trustedPublicHosts) ? u.href : null;
}
