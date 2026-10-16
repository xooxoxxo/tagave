/**
 * The resolved-address half of the Music Connections SSRF rules: what an IP
 * a request would connect to is, and whether tagave may connect to it.
 *
 *   blocked   always refused, whatever the URL says: 0.0.0.0/8, link-local
 *             169.254.0.0/16 and fe80::/10 (cloud metadata), multicast
 *             (224.0.0.0/4, ff00::/8), 240.0.0.0/4 with the broadcast
 *             address, `::`, and an IPv4-mapped or NAT64 address pointing at
 *             any of these;
 *   loopback  127.0.0.0/8 and ::1: only when the URL's host is literally
 *             loopback (localhost, 127.x, [::1]), never a name resolving there;
 *   private   RFC 1918, the tailnet's 100.64.0.0/10, IPv6 unique-local fc00::/7:
 *             any allowed host may reach these (a LAN name, a private literal);
 *   public    everything else: only a name in MC_TRUSTED_PUBLIC_HOSTS over https.
 *
 * Every address a name resolves to must pass, so a name answering with a
 * private and a public address is refused unless it is trusted.
 */
import { isIP } from 'node:net';

export type AddressClass = 'blocked' | 'loopback' | 'private' | 'public';

function v4Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

function classifyV4(b: number[]): AddressClass {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return 'blocked';
  if (a === 127) return 'loopback';
  if (a === 169 && c === 254) return 'blocked';
  if (a >= 224) return 'blocked'; // multicast 224/4, reserved 240/4, broadcast
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127)) return 'private';
  return 'public';
}

/** An IPv6 address as eight 16-bit groups (an embedded dotted quad allowed), or null. */
export function v6Groups(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (isIP(s) !== 6) return null;
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (quad) {
    const b = v4Bytes(quad[1]!);
    if (!b) return null;
    s = `${s.slice(0, -quad[1]!.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') as [string, string] : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** What `ip` is (a v4 or v6 literal, brackets allowed); anything unparsable is blocked. */
export function classifyAddress(ip: string): AddressClass {
  const b4 = v4Bytes(ip);
  if (b4) return classifyV4(b4);
  const g = v6Groups(ip);
  if (!g) return 'blocked';
  if (g.every((x) => x === 0)) return 'blocked'; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'; // ::1
  const embedded = (): number[] => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: what they point at
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return classifyV4(embedded());
  // NAT64 64:ff9b::/96 reaches IPv4 through a translator
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(embedded());
  if ((g[0]! & 0xffc0) === 0xfe80) return 'blocked'; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return 'blocked'; // multicast ff00::/8
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private'; // unique local fc00::/7
  return 'public';
}

/** The URL host without IPv6 brackets. */
export const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, '');

/** Is the URL's host literally loopback (localhost, 127.x.x.x, [::1])? */
export function isLiteralLoopback(hostname: string): boolean {
  const h = bareHost(hostname).toLowerCase();
  if (h === 'localhost') return true;
  return isIP(h) !== 0 && classifyAddress(h) === 'loopback';
}

/**
 * May a request to `hostname` connect to `ip`? `trustedName` is true when the
 * host is a name in MC_TRUSTED_PUBLIC_HOSTS reached over https.
 */
export function addressAllowed(hostname: string, ip: string, trustedName: boolean): boolean {
  const c = classifyAddress(ip);
  if (c === 'blocked') return false;
  if (c === 'loopback') return isLiteralLoopback(hostname);
  const h = bareHost(hostname).toLowerCase();
  // a LAN name (or a private literal) may reach the LAN; localhost reaches loopback only
  if (c === 'private') return h !== 'localhost';
  // public: only a trusted name over https, never a literal
  return trustedName && isIP(h) === 0;
}
