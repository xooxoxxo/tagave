import { hkdfSync } from 'node:crypto';

/** A configuration problem the app must refuse to start with (the message is for the operator). */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface PublicUrl {
  /** e.g. https://music.example.com (no trailing slash) */
  origin: string;
  /** The passkey RP ID: credentials are bound to it forever. */
  hostname: string;
  secure: boolean;
}

const PUBLIC_URL_HELP =
  'Set PUBLIC_URL in .env to the address you open tagave at in the browser, for example ' +
  'PUBLIC_URL=https://music.example.com or, on this computer only, PUBLIC_URL=http://localhost:3100. ' +
  'Passkeys and security keys are tied to its host name for good, so pick the name you will keep ' +
  '(docs/install.md, "Public URL").';

/**
 * PUBLIC_URL is required: it is Better Auth's base URL, the trusted origin
 * for sign-in, and the passkey relying-party ID (its host name).
 */
export function parsePublicUrl(raw: string | undefined): PublicUrl {
  const value = raw?.trim();
  if (!value) {
    throw new AuthConfigError(`PUBLIC_URL is not set. ${PUBLIC_URL_HELP}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`PUBLIC_URL is not a URL: "${value}". ${PUBLIC_URL_HELP}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthConfigError(`PUBLIC_URL must start with https:// or http://, got "${value}". ${PUBLIC_URL_HELP}`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new AuthConfigError(
      `PUBLIC_URL must be only scheme, host and port (tagave is served at the root), got "${value}". ${PUBLIC_URL_HELP}`,
    );
  }
  return { origin: url.origin, hostname: url.hostname, secure: url.protocol === 'https:' };
}

/** Browsers allow WebAuthn only on https origins and on localhost. */
export function passkeysCanWork(publicUrl: PublicUrl): boolean {
  return publicUrl.secure || publicUrl.hostname === 'localhost' || publicUrl.hostname.endsWith('.localhost');
}

/**
 * Better Auth's secret, derived from APP_SECRET (no second secret to manage).
 * Rotating APP_SECRET therefore signs everyone out and needs
 * `tagave-doctor reseal` to re-encrypt TOTP secrets and backup codes.
 */
export function deriveAuthSecret(appSecret: string): string {
  return Buffer.from(hkdfSync('sha256', appSecret, '', 'tagave/better-auth', 32)).toString('hex');
}

/**
 * TRUST_PROXY: which hops in front of tagave may name the client in
 * X-Forwarded-For. Fastify's `trustProxy` takes it as is, so request.ip is
 * the client's address for every limiter, and Better Auth reads that address
 * (CLIENT_IP_HEADER), never the raw header.
 *
 *   unset, false, no, 0   no proxy: the socket's address
 *   <n>                   the last n hops are proxies (TRUST_PROXY=1: one reverse proxy)
 *   <addr|cidr>,...       the proxies' addresses or networks (10.0.0.0/8,172.16.0.0/12;
 *                         also loopback, linklocal, uniquelocal)
 *   true, yes             deprecated: means 1, never "trust every hop"
 *
 * Trusting every hop would let any client name itself in X-Forwarded-For
 * and step around every per-address limit, so that is not on offer.
 */
export type TrustProxy = false | number | string[];

const PROXY_ADDR_RE = /^(?:([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([0-9a-f:]*:[0-9a-f:.]*))(?:\/([0-9]{1,3}))?$/i;
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
/** The widest proxy network taken: anything wider (0.0.0.0/0, ::/0) would trust nearly every peer. */
const MIN_PROXY_PREFIX = 8;

/** An address, or a network no wider than /8 and no longer than the address. */
function isProxyAddress(a: string): boolean {
  const m = PROXY_ADDR_RE.exec(a);
  if (!m) return false;
  if (m[3] === undefined) return true;
  const prefix = Number(m[3]);
  return prefix >= MIN_PROXY_PREFIX && prefix <= (m[1] !== undefined ? 32 : 128);
}
let trustProxyWarned = false;

export function parseTrustProxy(raw: string | undefined, warn: (message: string) => void = (m) => console.warn(m)): TrustProxy {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === 'no' || v === '0') return false;
  if (v === 'true' || v === 'yes') {
    if (!trustProxyWarned) {
      trustProxyWarned = true;
      warn(`TRUST_PROXY=${raw!.trim()} is deprecated and now means one proxy hop (TRUST_PROXY=1). Set the hop count, or the proxies' addresses (TRUST_PROXY=172.16.0.0/12).`);
    }
    return 1;
  }
  if (/^[0-9]+$/.test(v)) {
    const n = Number(v);
    if (n > 16) throw new AuthConfigError(`TRUST_PROXY=${v}: at most 16 proxy hops.`);
    return n;
  }
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  for (const a of list) {
    if (!PROXY_NAMES.has(a) && !isProxyAddress(a)) {
      throw new AuthConfigError(`TRUST_PROXY: "${a}" is not a hop count, an address or a network of /8 or narrower (e.g. TRUST_PROXY=1 or TRUST_PROXY=10.0.0.0/8,172.16.0.0/12).`);
    }
  }
  return list.length > 0 ? list : false;
}

/**
 * Fastify's `trustProxy` for a TrustProxy: a hop count becomes a function
 * trusting the nearest n hops (hop 0 is the socket's peer), a list stays a list.
 */
export function fastifyTrustProxy(tp: TrustProxy): false | string[] | ((address: string, hop: number) => boolean) {
  if (tp === false || tp === 0) return false;
  if (typeof tp === 'number') return (_address, hop) => hop < tp;
  return tp;
}

/** Tests only: warn again about TRUST_PROXY=true. */
export function resetTrustProxyWarning(): void {
  trustProxyWarned = false;
}

/**
 * The header the api sets on every request to the client's address
 * (Fastify's request.ip under TRUST_PROXY), replacing whatever the client
 * sent; Better Auth's limiter and the trusted-device list read it.
 */
export const CLIENT_IP_HEADER = 'x-tagave-client-ip';

export interface AuthEnvConfig {
  appSecret: string;
  publicUrl: PublicUrl;
  /** ALLOWED_ORIGINS ∪ PUBLIC_URL: origins that may call the sign-in endpoints. */
  trustedOrigins: string[];
  trustProxy: TrustProxy;
}

/** Read and check the auth settings from the environment. Throws AuthConfigError. */
export function readAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnvConfig {
  const appSecret = env['APP_SECRET'];
  if (!appSecret) throw new AuthConfigError('APP_SECRET is not set (see .env.example).');
  const publicUrl = parsePublicUrl(env['PUBLIC_URL']);
  const extra = (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*');
  const trustedOrigins = [...new Set([publicUrl.origin, ...extra])];
  return { appSecret, publicUrl, trustedOrigins, trustProxy: parseTrustProxy(env['TRUST_PROXY']) };
}
