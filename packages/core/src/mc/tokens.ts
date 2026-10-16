/**
 * A link's tokens, sealed: the access and refresh tokens and the client
 * secret tagave got from a remote, kept as one JSON value sealed with the
 * same AES-256-GCM key as every other credential (APP_SECRET,
 * crypto/secretbox.ts). Only ever opened in memory; never logged.
 */
import { isSealed, openSecret, sealSecret } from '../crypto/secretbox.js';

export interface LinkTokens {
  access_token: string;
  refresh_token: string;
  client_secret: string;
  /** ISO time the access token expires. */
  access_expires_at: string;
}

function secret(appSecret: string | undefined): string {
  if (!appSecret) throw new Error('APP_SECRET is not set');
  return appSecret;
}

export function sealTokens(tokens: LinkTokens, appSecret: string | undefined): string {
  return sealSecret(JSON.stringify(tokens), secret(appSecret));
}

/**
 * The tokens behind `sealed`, or null when there are none or they cannot be
 * opened (APP_SECRET changed, tampered). Unlike openSecret, a value that is
 * not sealed is refused, never passed through.
 */
export function openTokens(sealed: string | null | undefined, appSecret: string | undefined): LinkTokens | null {
  if (!sealed || !isSealed(sealed) || !appSecret) return null;
  try {
    const t = JSON.parse(openSecret(sealed, appSecret)) as Partial<LinkTokens>;
    if (typeof t.access_token !== 'string' || !t.access_token) return null;
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : '',
      client_secret: typeof t.client_secret === 'string' ? t.client_secret : '',
      access_expires_at: typeof t.access_expires_at === 'string' ? t.access_expires_at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/** One secret string (a pending link's client secret), sealed. */
export function sealOne(value: string, appSecret: string | undefined): string {
  return sealSecret(value, secret(appSecret));
}

/** The secret behind `sealed`, or null (not sealed, or cannot be opened). */
export function openOne(sealed: string | null | undefined, appSecret: string | undefined): string | null {
  if (!sealed || !isSealed(sealed) || !appSecret) return null;
  try {
    return openSecret(sealed, appSecret);
  } catch {
    return null;
  }
}

/** When an access token that lives `expiresIn` seconds (default 1 h) runs out. */
export function expiryFrom(expiresIn: unknown, now = Date.now()): string {
  const s = Number(expiresIn);
  return new Date(now + (Number.isFinite(s) && s > 0 ? s : 3600) * 1000).toISOString();
}
