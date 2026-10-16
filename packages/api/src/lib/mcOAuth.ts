/**
 * Music Connections (spec §2): tagave as an OAuth 2.0 provider. What the
 * endpoints (routes/connect.ts) and the feeds share: the scopes tagave
 * grants, the redirect-host allow-list, the one token hash and the bearer
 * lookup.
 *
 * Tokens, codes and client secrets are opaque random strings; only their
 * SHA-256 (hashToken) is stored. None of them is ever logged, put in a URL
 * (except the one-time code, in the redirect back to the client) or echoed in
 * an error.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { readScope, type Capability } from 'music-connections';
import { TAGAVE_CONSUMES as CORE_CONSUMES, TAGAVE_PROVIDES as CORE_PROVIDES } from '@tagave/core/mc';

export const PROTOCOL = 'music-connections/1';

/** What tagave serves to a linked app, and what it reads from one (@tagave/core/mc). */
export const TAGAVE_PROVIDES: readonly Capability[] = CORE_PROVIDES;
export const TAGAVE_CONSUMES: readonly Capability[] = CORE_CONSUMES;

export const OFFLINE_ACCESS = 'offline_access';
/** The capability scopes tagave grants: `<capability>:read` for each it provides. */
export const PROVIDER_SCOPES: readonly string[] = TAGAVE_PROVIDES.map(readScope);

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;
/** How long an authorize request waits for the person's decision. */
export const REQUEST_TTL_S = 10 * 60;
/** How long a code may wait for its exchange. */
export const CODE_TTL_S = 5 * 60;
/** Rotated refresh tokens are kept this long so a replay still revokes the family. */
export const ROTATED_KEEP_DAYS = 30;

/** Plain words for the consent page, one line per scope. */
export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  'ratings:read': 'Read your album ratings and favourites',
  'collection:read': 'Read which albums you own, and in which formats',
  'listens:read': 'Read how many times a day you play each album',
  'identity:read': 'Read which MusicBrainz release each of your albums is matched to',
  [OFFLINE_ACCESS]: 'Keep this access until you revoke it',
};

/** The one hash for every stored secret: hex SHA-256 of the UTF-8 string. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when `presented` hashes to `storedHash` (constant time). */
export function tokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A new opaque secret: a short kind prefix (for secret scanners) and 32 random bytes. */
export function newSecret(kind: 'mcc' | 'mcs' | 'mca' | 'mcr' | 'mcx' | 'mcq'): string {
  return `${kind}_${randomBytes(32).toString('base64url')}`;
}

/** PKCE S256: base64url(SHA-256(verifier)), no padding. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ── Redirect hosts ─────────────────────────────────────────────────────────

// One allow-list for the provider (redirect URIs) and the client (linked
// remotes): @tagave/core/mc.
export { isAllowedRedirect, parseTrustedHosts } from '@tagave/core/mc';

// ── Scopes ─────────────────────────────────────────────────────────────────

export type ScopeCheck = { ok: true; scopes: string[] } | { ok: false; reason: string };

/**
 * The `scope` of an authorize request: space-separated, each one tagave
 * grants or offline_access, at least one capability scope (offline_access
 * alone grants nothing). openid is refused: tagave issues no ID tokens.
 */
export function checkRequestedScopes(raw: string | undefined): ScopeCheck {
  const list = [...new Set((raw ?? '').split(' ').filter(Boolean))];
  if (list.includes('openid')) return { ok: false, reason: 'openid is not offered' };
  const unknown = list.filter((s) => s !== OFFLINE_ACCESS && !PROVIDER_SCOPES.includes(s));
  if (unknown.length > 0) return { ok: false, reason: `not offered: ${unknown.join(' ').slice(0, 200)}` };
  if (!list.some((s) => s !== OFFLINE_ACCESS)) return { ok: false, reason: 'ask for at least one capability scope' };
  // the order tagave lists them in, offline_access last
  return { ok: true, scopes: [...PROVIDER_SCOPES.filter((s) => list.includes(s)), ...(list.includes(OFFLINE_ACCESS) ? [OFFLINE_ACCESS] : [])] };
}

// ── Bearer lookup (the /mc/v1 feeds) ───────────────────────────────────────

export interface AccessGrant {
  tokenId: string;
  familyId: string;
  userId: string;
  clientId: string;
  /** Granted scopes, offline_access included when it was granted. */
  scopes: string[];
  expiresAt: Date;
}

/**
 * The live grant behind a bearer access token, or null: unknown, expired,
 * revoked, its client disabled, or its person disabled or removed. A token
 * whose refresh was rotated stays valid until it expires (at most an hour).
 * Callers check the scope themselves: `grant.scopes.includes(readScope(cap))`;
 * offline_access grants no data.
 */
export async function lookupAccessToken(sql: postgres.Sql, token: string): Promise<AccessGrant | null> {
  if (!token || token.length > 200) return null;
  const rows = await sql<Array<{ id: string; family_id: string; user_id: string; client_id: string; scopes: string[]; access_expires_at: Date }>>`
    select t.id, t.family_id, t.user_id, t.client_id, t.scopes, t.access_expires_at
      from mc_oauth_tokens t
      join mc_oauth_clients c on c.client_id = t.client_id
      join users u on u.id = t.user_id
     where t.access_token_hash = ${hashToken(token)}
       and t.revoked_at is null
       and t.access_expires_at > now()
       and c.disabled_at is null
       and u.disabled_at is null and u.removed_at is null`;
  const r = rows[0];
  if (!r) return null;
  return { tokenId: r.id, familyId: r.family_id, userId: r.user_id, clientId: r.client_id, scopes: r.scopes, expiresAt: r.access_expires_at };
}

/** Bearer token from an Authorization header, or '' (never logged). */
export function bearerToken(header: string | undefined): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1]! : '';
}
