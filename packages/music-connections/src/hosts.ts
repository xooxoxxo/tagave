/**
 * The host allow-list: which hosts a provider lets a client register as its
 * redirect URI, and which remotes a client links to and fetches from.
 *
 *   Redirect URIs (isAllowedRedirect): http or https on a private host (RFC
 *   1918, the CGNAT range 100.64.0.0/10 that tailnets use, 127.0.0.0/8,
 *   `localhost`), or https on a host named in the trusted list.
 *
 *   Remotes (isAllowedRemote): what isAllowedRedirect allows, or an http(s)
 *   URL whose host is a DNS name (a LAN or Docker service name). A name
 *   passes this gate only; where it may connect is decided per request on the
 *   addresses it resolves to (address.ts › checkResolvedAddresses).
 *
 * Both take only the canonical form of a URL (what URL serialises it to),
 * without a fragment, user info, whitespace or commas, up to MAX_URL_LENGTH.
 * IPv6 literals are never allowed here; `localhost` is the loopback name.
 */
import { MAX_URL_LENGTH } from "./limits.js";
import { ipVersion } from "./address.js";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

// Private LAN (RFC 1918), CGNAT (tailnets) and loopback.
const V4_RANGES: Array<[number, number]> = (
  [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["127.0.0.0", 8]] as const
).map(([ip, bits]) => [v4ToInt(ip), bits]);

/** `localhost`, or an IPv4 literal in a private, CGNAT or loopback range. */
export function isPrivateHost(host: string): boolean {
  if (host === "localhost") return true;
  if (ipVersion(host) !== 4) return false;
  const n = v4ToInt(host);
  return V4_RANGES.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

/** A trusted-hosts setting (comma-separated host names): trimmed, lower case, trailing dot dropped, empties dropped. */
export function parseTrustedHosts(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

/** `uri` as a URL when it is a canonical http(s) URL without user info, fragment, comma or whitespace; else null. */
export function canonicalHttpUrl(uri: unknown): URL | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > MAX_URL_LENGTH) return null;
  if (uri.includes(",") || uri.includes("#") || /\s/.test(uri)) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.href !== uri || u.username || u.password) return null;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

/**
 * A redirect URI a provider accepts at registration: http or https on a
 * private host, or https on a host in `trustedPublicHosts`.
 */
export function isAllowedRedirect(uri: unknown, trustedPublicHosts: readonly string[]): uri is string {
  const u = canonicalHttpUrl(uri);
  if (!u) return false;
  if (isPrivateHost(u.hostname)) return true;
  return u.protocol === "https:" && trustedPublicHosts.includes(u.hostname);
}

/**
 * The registration redirect policy: exactly one redirect URI (the consent
 * screen names its host, so it must be where the code goes), and it passes
 * isAllowedRedirect.
 */
export function isAllowedRegistration(redirectUris: unknown, trustedPublicHosts: readonly string[]): redirectUris is [string] {
  return Array.isArray(redirectUris) && redirectUris.length === 1 && isAllowedRedirect(redirectUris[0], trustedPublicHosts);
}

/** A DNS host name: labels of letters, digits and inner hyphens, 1 to 63 each, 253 in all. */
function isDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * A remote a client may link to and fetch from: what isAllowedRedirect
 * allows, or a canonical http(s) URL whose host is a DNS name, never
 * `*.localhost`, a name with a trailing dot or any other IP literal. Every
 * request to a name must still pass checkResolvedAddresses.
 */
export function isAllowedRemote(uri: unknown, trustedPublicHosts: readonly string[]): uri is string {
  if (isAllowedRedirect(uri, trustedPublicHosts)) return true;
  const u = canonicalHttpUrl(uri);
  if (!u) return false;
  const h = u.hostname;
  if (h.startsWith("[") || ipVersion(h) !== 0) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".")) return false;
  return isDnsName(h);
}
