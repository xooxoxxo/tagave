/**
 * Cast links: a Chromecast, an AirPlay speaker or an Apple TV fetches the
 * audio (and the cover) itself, without the person's session cookie. Each
 * link carries a token instead:
 *
 *   v1.<kind>.<id>.<userId>.<exp>.<sig>
 *
 *   kind    t (a track's audio, id = local track) or c (an album's cover, id = album)
 *   id      the uuid's 16 bytes, base64url (22 characters)
 *   userId  the same, for the person who made the link
 *   exp     unix seconds, base 36; about six hours after it was made
 *   sig     HMAC-SHA256 with APP_SECRET over "tagave-cast|v1|kind|id|userId|exp"
 *           (the uuids in their usual text form), its first 16 bytes, base64url
 *
 * Compact on purpose: a path parameter longer than 100 characters is
 * refused by the router (Fastify's maxParamLength), and this is about 80.
 *
 * A token opens that one track (or cover), for that one person, until it
 * expires; nothing else. Changing any part breaks the signature. The routes
 * check the person again on every request (still there, not turned off,
 * still allowed to play), so turning an account off ends its casts.
 *
 * The token is a credential while it lives: the request log redacts it
 * (logRedact.ts), and it is never written anywhere else.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CastReach } from '@tagave/shared';

export type CastKind = 't' | 'c';

/** A long album plays through; a stale link stops working the same evening. */
export const CAST_TTL_S = 6 * 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(appSecret?: string): string {
  const s = appSecret ?? process.env['APP_SECRET'];
  if (!s) throw new Error('APP_SECRET is not set');
  return s;
}

function mac(kind: CastKind, id: string, userId: string, exp: number, appSecret?: string): Buffer {
  return createHmac('sha256', secret(appSecret)).update(`tagave-cast|v1|${kind}|${id}|${userId}|${exp}`).digest();
}

/** 128 bits of HMAC-SHA256: far past guessing, and short enough for a path. */
const SIG_BYTES = 16;

const packUuid = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex').toString('base64url');
function unpackUuid(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  if (b.length !== 16 || b.toString('base64url') !== s) return null;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function mintCastToken(kind: CastKind, id: string, userId: string, opts: { now?: number; ttlS?: number; appSecret?: string } = {}): { token: string; expiresAt: Date } {
  if (!UUID.test(id) || !UUID.test(userId)) throw new Error('cast tokens name a uuid');
  const now = opts.now ?? Date.now();
  const exp = Math.floor(now / 1000) + (opts.ttlS ?? CAST_TTL_S);
  const sig = mac(kind, id.toLowerCase(), userId.toLowerCase(), exp, opts.appSecret).subarray(0, SIG_BYTES).toString('base64url');
  return { token: `v1.${kind}.${packUuid(id)}.${packUuid(userId)}.${exp.toString(36)}.${sig}`, expiresAt: new Date(exp * 1000) };
}

export interface CastGrant {
  kind: CastKind;
  id: string;
  userId: string;
  expiresAt: Date;
}

/** The grant a token carries, or null: malformed, another kind, tampered with, or expired. */
export function verifyCastToken(token: string | undefined, kind: CastKind, opts: { now?: number; appSecret?: string } = {}): CastGrant | null {
  if (!token || token.length > 100) return null;
  const parts = token.split('.');
  if (parts.length !== 6) return null;
  const [v, k, idRaw, userRaw, expRaw, sig] = parts as [string, string, string, string, string, string];
  if (v !== 'v1' || k !== kind || !/^[0-9a-z]{1,9}$/.test(expRaw)) return null;
  const id = unpackUuid(idRaw);
  const userId = unpackUuid(userRaw);
  if (!id || !userId) return null;
  const exp = parseInt(expRaw, 36);
  const now = opts.now ?? Date.now();
  if (exp * 1000 <= now) return null;
  const want = mac(kind, id, userId, exp, opts.appSecret).subarray(0, SIG_BYTES);
  const got = Buffer.from(sig, 'base64url');
  // only the canonical spelling: 16 bytes leave 4 spare bits in the last
  // character, and a decoder ignores them, so another spelling would pass
  if (got.length !== want.length || got.toString('base64url') !== sig || !timingSafeEqual(got, want)) return null;
  return { kind, id, userId, expiresAt: new Date(exp * 1000) };
}

/** PUBLIC_URL (no query or fragment), or null when it is not set (or not a URL). */
export function castBase(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env['PUBLIC_URL']?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.search = '';
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** An absolute link on PUBLIC_URL for an /api path. */
export function castLink(base: URL, path: string): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
}

function loopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/**
 * Can a cast device on the network reach PUBLIC_URL, as far as tagave can
 * tell from the address alone:
 *
 *   ok        https: what a Chromecast plays (with a certificate it trusts)
 *   http      plain http: AirPlay plays it; a Chromecast's receiver page is
 *             https, so the browser in it blocks the audio as mixed content
 *   loopback  localhost or 127.x: only this computer reaches it
 *   unset     PUBLIC_URL is not set
 */
export function castReach(env: NodeJS.ProcessEnv = process.env): CastReach {
  const base = castBase(env);
  if (!base) return 'unset';
  if (loopbackHost(base.hostname)) return 'loopback';
  return base.protocol === 'https:' ? 'ok' : 'http';
}
