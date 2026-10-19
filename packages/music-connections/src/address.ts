/**
 * The resolved-address half of the SSRF rules: what an IP a request would
 * connect to is, and whether a client may connect to it. Pure: the caller
 * resolves the name (see `music-connections/node`) and passes the answers in.
 *
 *   blocked   always refused, whatever the URL says: 0.0.0.0/8, link-local
 *             169.254.0.0/16 and fe80::/10 (cloud metadata), multicast
 *             (224.0.0.0/4, ff00::/8), 240.0.0.0/4 with the broadcast
 *             address, `::`, and an IPv4-mapped, IPv4-compatible or NAT64
 *             address pointing at any of these; anything unparsable;
 *   loopback  127.0.0.0/8 and ::1: only when the URL's host is literally
 *             loopback (localhost, 127.x; the host gate refuses IPv6 literals, so
 *             [::1] never passes), never a name resolving there;
 *   private   RFC 1918, the CGNAT range 100.64.0.0/10 (tailnets), IPv6
 *             unique-local fc00::/7: any allowed host may reach these;
 *   public    everything else: only a trusted name over https.
 *
 * Every address a name resolves to must pass (checkResolvedAddresses), so a
 * name answering with a private and a public address is refused unless it
 * is trusted.
 */
import { LinkError } from "./errors.js";

export type AddressClass = "blocked" | "loopback" | "private" | "public";

/** The four bytes of a dotted-quad IPv4 literal (no leading zeros), or null. */
export function v4Bytes(ip: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const parts = ip.split(".");
  if (parts.some((p) => p.length > 1 && p.startsWith("0"))) return null;
  const b = parts.map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** An IPv6 address as eight 16-bit groups (brackets, a zone and an embedded dotted quad allowed), or null. */
export function v6Groups(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) {
    if (pct === s.length - 1) return null;
    s = s.slice(0, pct);
  }
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  // an embedded dotted quad, last only
  const quad = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (quad) {
    const b = v4Bytes(quad[1]!);
    if (!b) return null;
    s = `${s.slice(0, -quad[1]!.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === "") return [];
    const g = part.split(":");
    return g.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? g : null;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** 4 for an IPv4 literal, 6 for an IPv6 one (brackets allowed), 0 otherwise. Like node:net isIP. */
export function ipVersion(s: string): 0 | 4 | 6 {
  if (v4Bytes(s)) return 4;
  if (v6Groups(s)) return 6;
  return 0;
}

function classifyV4(b: number[]): AddressClass {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return "blocked";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "blocked";
  if (a >= 224) return "blocked"; // multicast 224/4, reserved 240/4, broadcast
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127)) return "private";
  return "public";
}

/** What `ip` is (a v4 or v6 literal, brackets allowed); anything unparsable is blocked. */
export function classifyAddress(ip: string): AddressClass {
  const b4 = v4Bytes(ip);
  if (b4) return classifyV4(b4);
  const g = v6Groups(ip);
  if (!g) return "blocked";
  if (g.every((x) => x === 0)) return "blocked"; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback"; // ::1
  const embedded = (): number[] => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: what they point at
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return classifyV4(embedded());
  // NAT64 64:ff9b::/96 reaches IPv4 through a translator
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(embedded());
  if ((g[0]! & 0xffc0) === 0xfe80) return "blocked"; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return "blocked"; // multicast ff00::/8
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // unique local fc00::/7
  return "public";
}

/** The URL host without IPv6 brackets. */
export const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, "");

/** Is the URL's host literally loopback (localhost, 127.x.x.x; the host gate refuses IPv6 literals such as [::1])? */
export function isLiteralLoopback(hostname: string): boolean {
  const h = bareHost(hostname).toLowerCase();
  if (h === "localhost") return true;
  return ipVersion(h) !== 0 && classifyAddress(h) === "loopback";
}

/**
 * May a request to `hostname` connect to `ip`? `trustedName` is true when the
 * host is a trusted name reached over https (isTrustedName).
 */
export function addressAllowed(hostname: string, ip: string, trustedName: boolean): boolean {
  const c = classifyAddress(ip);
  if (c === "blocked") return false;
  if (c === "loopback") return isLiteralLoopback(hostname);
  const h = bareHost(hostname).toLowerCase();
  // a LAN name (or a private literal) may reach the LAN; localhost reaches loopback only
  if (c === "private") return h !== "localhost";
  // public: only a trusted name over https, never a literal
  return trustedName && ipVersion(h) === 0;
}

/** Is `url`'s host a name (not a literal) in `trustedPublicHosts`, reached over https? */
export function isTrustedName(url: URL, trustedPublicHosts: readonly string[]): boolean {
  const host = bareHost(url.hostname).toLowerCase();
  return url.protocol === "https:" && ipVersion(host) === 0 && trustedPublicHosts.includes(host);
}

/**
 * The one address a request to `url` connects to, given what its host
 * resolved to (`addresses`; for an IP literal, the literal itself). Every
 * address must pass addressAllowed; the first is returned. Throws LinkError
 * ('remote unresolvable', 'address not allowed'). The URL itself must already
 * have passed the host gate (isAllowedRemote).
 */
export function checkResolvedAddresses(url: URL, addresses: readonly string[], trustedPublicHosts: readonly string[]): string {
  if (addresses.length === 0) throw new LinkError("remote unresolvable");
  const host = bareHost(url.hostname);
  const trusted = isTrustedName(url, trustedPublicHosts);
  for (const ip of addresses) if (!addressAllowed(host, ip, trusted)) throw new LinkError("address not allowed");
  return addresses[0]!;
}
