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
 * `liner-doctor reseal` to re-encrypt TOTP secrets and backup codes.
 */
export function deriveAuthSecret(appSecret: string): string {
  return Buffer.from(hkdfSync('sha256', appSecret, '', 'tagave/better-auth', 32)).toString('hex');
}

export interface AuthEnvConfig {
  appSecret: string;
  publicUrl: PublicUrl;
  /** ALLOWED_ORIGINS ∪ PUBLIC_URL: origins that may call the sign-in endpoints. */
  trustedOrigins: string[];
  trustProxy: boolean;
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
  return { appSecret, publicUrl, trustedOrigins, trustProxy: env['TRUST_PROXY'] === 'true' };
}
