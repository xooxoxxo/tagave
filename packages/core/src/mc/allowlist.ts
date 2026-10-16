/**
 * Music Connections host allow-list (spec §2, §5 Security): which hosts
 * tagave talks to, as a provider (the redirect URIs a client may register,
 * api › routes/connect.ts) and as a client (the remotes a person may link,
 * their auth endpoints and feeds). One rule for both:
 *
 *   http or https on a private host (RFC 1918 LAN, the tailnet's
 *   100.64.0.0/10, loopback), or https on a host named in
 *   MC_TRUSTED_PUBLIC_HOSTS.
 *
 * Host names are taken literally: a name is private only when it is
 * `localhost`; any other name needs https and the trusted list.
 */

import { isIP } from 'node:net';

/** What tagave serves to a linked app, and what it reads from one. */
export const TAGAVE_PROVIDES = ['ratings', 'collection', 'listens', 'identity'] as const;
export const TAGAVE_CONSUMES = ['critic-scores', 'identity', 'wantlist-suggestions'] as const;

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

// Private LAN (RFC 1918), the tailnet's CGNAT range and loopback.
const V4_RANGES: Array<[number, number]> = (
  [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8]] as const
).map(([ip, bits]) => [v4ToInt(ip), bits]);

function isV4(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && h.split('.').every((o) => Number(o) <= 255);
}

export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  if (!isV4(host)) return false;
  const n = v4ToInt(host);
  return V4_RANGES.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

/** MC_TRUSTED_PUBLIC_HOSTS: comma-separated host names, trimmed, lower case, trailing dot dropped. */
export function parseTrustedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

/**
 * A URL tagave may send a browser or a request to: http or https on a
 * private host (LAN, tailnet, loopback), or https on a host in
 * MC_TRUSTED_PUBLIC_HOSTS. Only the canonical form (what URL serialises it
 * to), without a fragment, user info, whitespace or commas, up to 2048
 * characters.
 */
export function isAllowedRedirect(uri: unknown, trustedPublicHosts: readonly string[]): uri is string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) return false;
  if (uri.includes(',') || uri.includes('#') || /\s/.test(uri)) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.href !== uri || u.username || u.password) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (isPrivateHost(u.hostname)) return true;
  return u.protocol === 'https:' && trustedPublicHosts.includes(u.hostname);
}

/** A DNS host name: labels of letters, digits and inner hyphens, 1–63 each, 253 in all. */
function isDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split('.').every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * A remote tagave may link to and fetch from (client side only; the
 * provider's redirect URIs keep isAllowedRedirect): what isAllowedRedirect
 * allows, or a canonical http(s) URL whose host is a DNS name (a LAN name,
 * a Docker service name), never `localhost`, `*.localhost` or a name with a
 * trailing dot. A name passes this gate only; where it may connect is
 * decided per request on the addresses it resolves to (address.ts): private
 * ones only, unless the name is trusted and the URL https.
 */
export function isAllowedRemote(uri: unknown, trustedPublicHosts: readonly string[]): uri is string {
  if (isAllowedRedirect(uri, trustedPublicHosts)) return true;
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) return false;
  if (uri.includes(',') || uri.includes('#') || /\s/.test(uri)) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.href !== uri || u.username || u.password) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname;
  if (isIP(h.replace(/^\[|\]$/g, '')) !== 0) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.')) return false;
  return isDnsName(h);
}
