/**
 * Sign in with your own login service: one generic OpenID Connect provider
 * (Zitadel, Authentik, Authelia, Keycloak, Pocket ID, ...) set up in
 * Settings › Users and stored in auth_oidc_config (0074).
 *
 * Better Auth's genericOAuth plugin does the protocol: discovery, state (a
 * database row plus a signed cookie bound to this browser), PKCE (S256), the
 * id_token nonce and its signature, issuer and audience (requireIdTokenVerification).
 * tagave adds what decides who gets in:
 *
 *  - Nothing links by email. accountLinking stays closed to implicit links
 *    (disableImplicitLinking); only a signed-in person's explicit link from
 *    Account (and a re-verification of that same link) passes validateUserInfo.
 *  - A new account comes only from an open invite or, when "Anyone from
 *    <name> can join" is on, from a first sign-in by someone in the group.
 *  - The issuer is the one the owner set: discovery must name it exactly,
 *    and so must every id_token.
 *  - Tokens are not kept: the service's access, refresh and id tokens are
 *    dropped before the account row is written.
 *
 * Which flow a callback belongs to comes from the OAuth state, which only the
 * api writes (auth.api.signInSocial / linkSocial are not on the HTTP router).
 */
import { createHash, createPublicKey, type JsonWebKeyInput, type KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { BetterAuthPlugin } from 'better-auth';
import { getOAuthState } from 'better-auth/api';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { genericOAuth } from 'better-auth/plugins';
import type postgres from 'postgres';
import { deriveAuthSecret } from './config.js';
import { recordStepUp } from './step-up.js';

export const OIDC_PROVIDER_ID = 'oidc';
/** Where the service sends people back (relative to PUBLIC_URL). */
export const OIDC_CALLBACK_PATH = `/api/auth/callback/${OIDC_PROVIDER_ID}`;
/** A re-verification counts when the service's auth_time is this close to the request (clock skew allowed). */
export const OIDC_STEP_UP_SKEW_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * fetch for the login service's endpoints, on node:http(s): never follows a
 * redirect, reads at most MAX_BODY_BYTES, and an aborted signal destroys the
 * socket at once. (undici's fetch keeps the socket of an aborted request
 * open, so an issuer that never answers would pile up connections.)
 */
export const serviceFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: init?.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) out.append(k, x);
          else if (v !== undefined) out.set(k, v);
        }
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: out }));
      });
      res.on('error', reject);
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', reject);
    if (init?.body != null) req.write(String(init.body));
    req.end();
  });

export type OidcIntent = 'sign-in' | 'invite' | 'link' | 'step-up';

export interface OidcSettings {
  name: string;
  /** Exactly as the service's discovery document names it. */
  issuer: string;
  clientId: string;
  /** Decrypted; null for a public client (PKCE only). */
  clientSecret: string | null;
  enabled: boolean;
  joinEnabled: boolean;
  /** Only people with this group (groups claim) may join; null: anyone. */
  joinGroup: string | null;
}

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

export function oidcRedirectUri(publicOrigin: string): string {
  return `${publicOrigin}${OIDC_CALLBACK_PATH}`;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** The issuer as typed: an https URL (http only on this computer), no query or fragment. */
export function parseIssuerInput(raw: string): URL {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigError('The issuer is not a URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new OidcConfigError('The issuer must start with https://.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new OidcConfigError('The issuer must not have a query, fragment or user name.');
  }
  return url;
}

const withoutSlash = (s: string) => s.replace(/\/+$/, '');

/** The discovery document's URL for an issuer (OpenID Connect Discovery 1.0, section 4). */
export function discoveryUrlFor(issuer: string): string {
  return `${withoutSlash(issuer)}/.well-known/openid-configuration`;
}

export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string;
  /** Whether the service says it supports S256 (absent from the document: unknown). */
  pkceS256: boolean | null;
  scopes: string[];
  /** id_token_signing_alg_values_supported, as the document lists them. */
  signingAlgs: string[];
}

function urlField(doc: Record<string, unknown>, key: string, required: true): string;
function urlField(doc: Record<string, unknown>, key: string, required: false): string | null;
function urlField(doc: Record<string, unknown>, key: string, required: boolean): string | null {
  const v = doc[key];
  if (typeof v !== 'string' || !v) {
    if (required) throw new OidcConfigError(`The discovery document has no ${key}.`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new OidcConfigError(`The discovery document's ${key} is not a URL.`);
  }
  // codes, tokens and keys travel these: https, plain http only on this computer
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new OidcConfigError(`The discovery document's ${key} must be https.`);
  }
  return url.toString();
}

/**
 * Fetch and check the service's discovery document (Test, Save). The issuer
 * it names must be the one typed (a trailing slash either way is forgiven;
 * the document's spelling is what is kept), it must be OpenID Connect (signs
 * id_tokens, publishes its keys) and offer the code flow.
 */
export async function discoverOidc(
  issuerInput: string,
  fetchImpl: typeof fetch = serviceFetch,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<OidcDiscovery> {
  const typed = parseIssuerInput(issuerInput).toString();
  let res: Response;
  try {
    res = await fetchImpl(discoveryUrlFor(typed), {
      headers: { accept: 'application/json' },
      // a redirect is an answer from somewhere else: refused, never followed
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new OidcConfigError('Could not reach the issuer.');
  }
  if (res.status >= 300 && res.status < 400 || res.type === 'opaqueredirect') {
    throw new OidcConfigError('The issuer redirected its discovery document elsewhere.');
  }
  if (!res.ok) throw new OidcConfigError(`The issuer answered ${res.status} for its discovery document.`);
  let doc: Record<string, unknown>;
  try {
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new OidcConfigError('The discovery document is not JSON.');
  }
  if (!doc || typeof doc !== 'object') throw new OidcConfigError('The discovery document is not JSON.');
  const issuer = typeof doc['issuer'] === 'string' ? doc['issuer'] : '';
  if (!issuer || withoutSlash(issuer) !== withoutSlash(typed)) {
    throw new OidcConfigError(`The discovery document names another issuer (${issuer || 'none'}).`);
  }
  parseIssuerInput(issuer);
  const algs = doc['id_token_signing_alg_values_supported'];
  if (!Array.isArray(algs) || algs.length === 0) throw new OidcConfigError('The issuer does not sign id_tokens (not OpenID Connect).');
  const responseTypes = doc['response_types_supported'];
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) throw new OidcConfigError('The issuer does not offer the code flow.');
  const pkce = doc['code_challenge_methods_supported'];
  const scopes = doc['scopes_supported'];
  return {
    issuer,
    authorizationEndpoint: urlField(doc, 'authorization_endpoint', true),
    tokenEndpoint: urlField(doc, 'token_endpoint', true),
    userinfoEndpoint: urlField(doc, 'userinfo_endpoint', false),
    jwksUri: urlField(doc, 'jwks_uri', true),
    pkceS256: Array.isArray(pkce) ? pkce.includes('S256') : null,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [],
    signingAlgs: algs.filter((a): a is string => typeof a === 'string' && a !== 'none'),
  };
}

const ZITADEL_ROLES = /^urn:zitadel:iam:org:project:(?:[^:]+:)?roles$/;

/**
 * The groups a profile says its person is in: the `groups` claim (Authentik,
 * Authelia, Keycloak with a group mapper, Pocket ID, Dex) and Zitadel's
 * project roles (`urn:zitadel:iam:org:project:roles`, an object keyed by role).
 */
export function groupsOf(profile: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const g = profile['groups'];
  if (Array.isArray(g)) for (const v of g) if (typeof v === 'string') out.add(v);
  if (typeof g === 'string') out.add(g);
  for (const [k, v] of Object.entries(profile)) {
    if (ZITADEL_ROLES.test(k) && v && typeof v === 'object' && !Array.isArray(v)) for (const role of Object.keys(v)) out.add(role);
  }
  return [...out];
}

export function inJoinGroup(profile: Record<string, unknown>, group: string | null): boolean {
  if (!group) return true;
  return groupsOf(profile).includes(group);
}

// ---------------------------------------------------------------- storage

interface ConfigRow {
  name: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  enabled: boolean;
  join_enabled: boolean;
  join_group: string | null;
  updated_at: Date;
}

/** What Settings › Users shows: never the secret, only whether one is set. */
export interface OidcSettingsView {
  name: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
  enabled: boolean;
  joinEnabled: boolean;
  joinGroup: string | null;
  updatedAt: string;
}

async function tableExists(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<Array<{ t: string | null }>>`select to_regclass('public.auth_oidc_config')::text as t`;
  return Boolean(row?.t);
}

async function readRow(sql: postgres.Sql): Promise<ConfigRow | null> {
  if (!(await tableExists(sql))) return null;
  const [row] = await sql<ConfigRow[]>`
    select name, issuer, client_id, client_secret, enabled, join_enabled, join_group, updated_at from auth_oidc_config where id = 1`;
  return row ?? null;
}

export async function readOidcSettingsView(sql: postgres.Sql): Promise<OidcSettingsView | null> {
  const row = await readRow(sql);
  if (!row) return null;
  return {
    name: row.name,
    issuer: row.issuer,
    clientId: row.client_id,
    secretSet: Boolean(row.client_secret),
    enabled: row.enabled,
    joinEnabled: row.join_enabled,
    joinGroup: row.join_group,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * The settings with the secret opened. A secret that does not open with this
 * APP_SECRET (rotated without `tagave-doctor reseal`) turns the service off
 * until the owner enters it again, instead of failing every sign-in.
 */
export async function readOidcSettings(sql: postgres.Sql, appSecret: string): Promise<{ settings: OidcSettings | null; secretUnreadable: boolean }> {
  const row = await readRow(sql);
  if (!row) return { settings: null, secretUnreadable: false };
  let clientSecret: string | null = null;
  let secretUnreadable = false;
  if (row.client_secret) {
    try {
      clientSecret = await symmetricDecrypt({ key: deriveAuthSecret(appSecret), data: row.client_secret });
      if (!clientSecret) secretUnreadable = true;
    } catch {
      secretUnreadable = true;
    }
  }
  return {
    settings: {
      name: row.name,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret,
      enabled: row.enabled && !secretUnreadable,
      joinEnabled: row.join_enabled,
      joinGroup: row.join_group,
    },
    secretUnreadable,
  };
}

export interface OidcSettingsInput {
  name: string;
  /** As the discovery document spells it (discoverOidc). */
  issuer: string;
  clientId: string;
  /** undefined: keep the stored one; null: none (public client); a string: replace. */
  clientSecret: string | null | undefined;
  enabled: boolean;
  joinEnabled: boolean;
  joinGroup: string | null;
}

export async function saveOidcSettings(sql: postgres.Sql, appSecret: string, input: OidcSettingsInput, actorId: string | null): Promise<void> {
  const sealed = typeof input.clientSecret === 'string'
    ? await symmetricEncrypt({ key: deriveAuthSecret(appSecret), data: input.clientSecret })
    : null;
  const keep = input.clientSecret === undefined;
  await sql`
    insert into auth_oidc_config (id, name, issuer, client_id, client_secret, enabled, join_enabled, join_group, updated_by, updated_at)
    values (1, ${input.name}, ${input.issuer}, ${input.clientId}, ${sealed}, ${input.enabled}, ${input.joinEnabled}, ${input.joinGroup}, ${actorId}, now())
    on conflict (id) do update set
      name = excluded.name, issuer = excluded.issuer, client_id = excluded.client_id,
      client_secret = case when ${keep} then auth_oidc_config.client_secret else excluded.client_secret end,
      enabled = excluded.enabled, join_enabled = excluded.join_enabled, join_group = excluded.join_group,
      updated_by = excluded.updated_by, updated_at = now()`;
}

export async function deleteOidcSettings(sql: postgres.Sql): Promise<void> {
  if (await tableExists(sql)) await sql`delete from auth_oidc_config where id = 1`;
}

/** Re-encrypt the client secret for a new APP_SECRET (`tagave-doctor reseal`). Idempotent. */
export async function resealOidcSecret(sql: postgres.Sql, oldAppSecret: string, newAppSecret: string): Promise<'none' | 'resealed' | 'current'> {
  const row = await readRow(sql);
  if (!row?.client_secret) return 'none';
  const open = async (key: string) => {
    try {
      const plain = await symmetricDecrypt({ key, data: row.client_secret! });
      return plain || null;
    } catch {
      return null;
    }
  };
  const newKey = deriveAuthSecret(newAppSecret);
  if ((await open(newKey)) !== null) return 'current';
  const plain = await open(deriveAuthSecret(oldAppSecret));
  if (plain === null) throw new Error('the login service client secret opens with neither the old nor the new APP_SECRET; nothing was changed');
  await sql`update auth_oidc_config set client_secret = ${await symmetricEncrypt({ key: newKey, data: plain })} where id = 1`;
  return 'resealed';
}

// ---------------------------------------------------------------- accounts

export interface WaysIn {
  password: boolean;
  passkeys: number;
  oidc: boolean;
}

export async function waysIn(sql: postgres.Sql, userId: string): Promise<WaysIn> {
  const [row] = await sql<Array<{ password: boolean; passkeys: number; oidc: boolean }>>`
    select
      exists (select 1 from auth_accounts where user_id = ${userId} and provider_id = 'credential' and password is not null) as password,
      (select count(*)::int from auth_passkeys where user_id = ${userId}) as passkeys,
      exists (select 1 from auth_accounts where user_id = ${userId} and provider_id = ${OIDC_PROVIDER_ID}) as oidc`;
  return { password: Boolean(row?.password), passkeys: row?.passkeys ?? 0, oidc: Boolean(row?.oidc) };
}

/**
 * Removing someone: the login-service identities linked to them may not join
 * again (an invite can still bring them back). Run before their accounts go.
 */
export async function refuseOidcRejoin(sql: postgres.Sql | postgres.TransactionSql, userId: string): Promise<void> {
  await sql`
    insert into auth_oidc_refused (account_id)
    select account_id from auth_accounts where user_id = ${userId} and provider_id = ${OIDC_PROVIDER_ID}
    on conflict (account_id) do nothing`;
}

/** Owners keep a way in that does not depend on the login service. */
export function hasLocalWayIn(w: WaysIn): boolean {
  return w.password || w.passkeys > 0;
}

export const hashInviteToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

interface OpenInvite {
  id: string;
  email: string;
  role: 'owner' | 'editor' | 'listener';
}

async function openInviteByHash(sql: postgres.Sql, tokenHash: string): Promise<OpenInvite | null> {
  const [row] = await sql<OpenInvite[]>`
    select id, email, role from user_invites
     where token_hash = ${tokenHash} and purpose = 'invite' and used_at is null and revoked_at is null and expires_at > now()`;
  return row ?? null;
}

// ---------------------------------------------------------------- flow state

/** What the api puts in the OAuth state (additionalData) when it starts a flow. */
export interface OidcFlowData {
  tagaveIntent: OidcIntent;
  /** invite: the SHA-256 of the invite token (the token itself is never stored). */
  tagaveInvite?: string;
  /** step-up: the session that asked, and when (ms). */
  tagaveSession?: string;
  tagaveStartedAt?: number;
}

async function flowData(): Promise<Partial<OidcFlowData>> {
  try {
    const state = (await getOAuthState()) as Record<string, unknown> | null;
    if (!state) return {};
    const intent = state['tagaveIntent'];
    return {
      ...(intent === 'sign-in' || intent === 'invite' || intent === 'link' || intent === 'step-up' ? { tagaveIntent: intent } : {}),
      ...(typeof state['tagaveInvite'] === 'string' ? { tagaveInvite: state['tagaveInvite'] } : {}),
      ...(typeof state['tagaveSession'] === 'string' ? { tagaveSession: state['tagaveSession'] } : {}),
      ...(typeof state['tagaveStartedAt'] === 'number' ? { tagaveStartedAt: state['tagaveStartedAt'] } : {}),
    };
  } catch {
    return {};
  }
}

/** auth_time (seconds) fresh for a re-verification started at `startedAt` (ms). */
export function authTimeFresh(authTime: unknown, startedAt: number | undefined, now = Date.now()): boolean {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime) || startedAt === undefined) return false;
  const at = authTime * 1000;
  return at >= startedAt - OIDC_STEP_UP_SKEW_MS && at <= now + OIDC_STEP_UP_SKEW_MS;
}

/** Refused, with one code for every reason (the callback page says only that it did not work). */
const REFUSED = { error: 'oidc_refused', errorDescription: 'not allowed' } as const;

interface ValidateData {
  user: { id?: string; email?: string | null };
  source: { method: string; action?: string; oauth?: { providerId: string; profile?: Record<string, unknown> } };
}

/**
 * The gate (Better Auth's user.validateUserInfo), for every user this
 * service would sign in, make or link. Fails closed: anything not named here
 * is refused.
 */
export function oidcGate(sql: postgres.Sql, getSettings: () => OidcSettings | null) {
  return async (data: ValidateData): Promise<{ error: string; errorDescription?: string } | undefined> => {
    if (data.source.method !== 'oauth') return undefined;
    if (data.source.oauth?.providerId !== OIDC_PROVIDER_ID) return REFUSED;
    const settings = getSettings();
    if (!settings?.enabled) return REFUSED;
    const profile = data.source.oauth.profile ?? {};
    const sub = typeof profile['sub'] === 'string' ? profile['sub'] : null;
    // the profile's issuer was checked against the settings (profileFromTokens)
    const key = sub ? oidcAccountKey(settings.issuer, sub) : null;
    const flow = await flowData();
    switch (data.source.action) {
      case 'sign-in':
        // an identity already linked to an account
        return flow.tagaveIntent === 'sign-in' || flow.tagaveIntent === 'invite' ? undefined : REFUSED;
      case 'create-user': {
        if (flow.tagaveIntent === 'invite') {
          const invite = flow.tagaveInvite ? await openInviteByHash(sql, flow.tagaveInvite) : null;
          // an owner always keeps a password or passkey: owner invites are accepted with a password
          return invite && invite.role !== 'owner' ? undefined : REFUSED;
        }
        if (flow.tagaveIntent !== 'sign-in' || !settings.joinEnabled || !inJoinGroup(profile, settings.joinGroup) || !key) return REFUSED;
        // someone the owner removed does not come back by joining
        const [removed] = await sql`select 1 from auth_oidc_refused where account_id = ${key}`;
        return removed ? REFUSED : undefined;
      }
      case 'link-account': {
        const userId = data.user.id;
        if (!userId) return REFUSED;
        if (flow.tagaveIntent === 'link') return undefined;
        if (flow.tagaveIntent === 'step-up') {
          if (!key || !flow.tagaveSession) return REFUSED;
          // the same identity this account already has, signed in again just now
          const [linked] = await sql`
            select 1 from auth_accounts where provider_id = ${OIDC_PROVIDER_ID} and account_id = ${key} and user_id = ${userId}`;
          if (!linked) return REFUSED;
          if (!authTimeFresh(profile['auth_time'], flow.tagaveStartedAt)) return REFUSED;
          const [session] = await sql`
            select 1 from auth_sessions where id = ${flow.tagaveSession} and user_id = ${userId} and expires_at > now()`;
          if (!session) return REFUSED;
          await recordStepUp(sql, flow.tagaveSession, userId, 'oidc');
          return undefined;
        }
        return REFUSED;
      }
      default:
        return REFUSED;
    }
  };
}

/**
 * Better Auth's user.create.before for an account the service makes: an
 * invite gives its role and email address and is used up here (one use); a
 * join is a listener. A provider profile never sets the role.
 */
export function oidcUserCreateBefore(sql: postgres.Sql) {
  return async (user: Record<string, unknown>): Promise<boolean | { data: Record<string, unknown> } | undefined> => {
    const flow = await flowData();
    if (!flow.tagaveIntent) return undefined;
    if (flow.tagaveIntent === 'invite') {
      if (!flow.tagaveInvite) return false;
      const [invite] = await sql<OpenInvite[]>`
        update user_invites set used_at = now()
         where token_hash = ${flow.tagaveInvite} and purpose = 'invite' and role <> 'owner'
           and used_at is null and revoked_at is null and expires_at > now()
         returning id, email, role`;
      if (!invite) return false;
      return { data: { ...user, email: invite.email.toLowerCase(), emailVerified: true, role: invite.role } };
    }
    if (flow.tagaveIntent === 'sign-in') return { data: { ...user, role: 'listener' } };
    return false;
  };
}

/** The service's tokens are not kept (tagave never calls the service with them). */
export function withoutOidcTokens(account: Record<string, unknown>): { data: Record<string, unknown> } | undefined {
  if (account['providerId'] !== OIDC_PROVIDER_ID) return undefined;
  return { data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } };
}

// ---------------------------------------------------------------- plugin

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The profile for an id_token Better Auth has already verified (signature
 * against the discovery keys, issuer, audience, expiry, nonce). An answer
 * without an id_token, or naming another issuer than the one set, is
 * refused; claims missing from the token come from the userinfo endpoint,
 * for the same `sub` only, and never replace the token's own.
 */
export async function profileFromTokens(
  tokens: { idToken?: string | undefined; accessToken?: string | undefined },
  expectedIssuer: string,
  userinfoEndpoint: string | null,
  fetchImpl: typeof fetch = serviceFetch,
): Promise<Record<string, unknown> | null> {
  if (!tokens.idToken) return null;
  const claims = decodeJwtPayload(tokens.idToken);
  if (!claims || claims['iss'] !== expectedIssuer) return null;
  const sub = claims['sub'];
  if (typeof sub !== 'string' || !sub) return null;
  let info: Record<string, unknown> = {};
  // Zitadel leaves email and profile out of the id_token unless told; Authelia
  // sends groups only from userinfo
  const missing = typeof claims['email'] !== 'string' || !claims['name'] || claims['groups'] === undefined;
  if (missing && userinfoEndpoint && tokens.accessToken) {
    try {
      const res = await fetchImpl(userinfoEndpoint, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        if (body && body['sub'] === sub) info = body;
      }
    } catch {
      // the id_token's claims are enough to go on
    }
  }
  const merged: Record<string, unknown> = { ...info, ...claims };
  const email = typeof merged['email'] === 'string' ? merged['email'] : undefined;
  const name = [merged['name'], merged['preferred_username'], email].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  return {
    ...merged,
    id: sub,
    sub,
    email,
    emailVerified: merged['email_verified'] === true,
    name: name ?? '',
    image: typeof merged['picture'] === 'string' ? merged['picture'] : undefined,
  };
}

/** The account key for an identity: its `sub`, namespaced by the issuer (an id at one service means nothing at another). */
export function oidcAccountKey(issuer: string, sub: string): string {
  return createHash('sha256').update(`${issuer}:${sub}`, 'utf8').digest('base64url');
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;

/**
 * The service's signing keys, for jose's jwtVerify: fetched with a time
 * limit and never through a redirect, kept for JWKS_TTL_MS, fetched again
 * for an unknown key id at most every JWKS_COOLDOWN_MS.
 */
export function remoteKeys(jwksUri: string, fetchImpl: typeof fetch = serviceFetch, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  let keys: Array<Record<string, unknown>> = [];
  let fetchedAt = 0;
  const load = async () => {
    const res = await fetchImpl(jwksUri, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`the signing keys answered ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    keys = Array.isArray(body.keys) ? (body.keys as Array<Record<string, unknown>>) : [];
    fetchedAt = Date.now();
  };
  const pick = (header: { kid?: string | undefined }) => {
    const usable = keys.filter((k) => k['use'] === undefined || k['use'] === 'sig');
    if (header.kid) return usable.find((k) => k['kid'] === header.kid);
    return usable.length === 1 ? usable[0] : undefined;
  };
  return async (header: { kid?: string | undefined }): Promise<KeyObject> => {
    if (Date.now() - fetchedAt > JWKS_TTL_MS) await load();
    let jwk = pick(header);
    if (!jwk && Date.now() - fetchedAt > JWKS_COOLDOWN_MS) {
      await load();
      jwk = pick(header);
    }
    if (!jwk) throw new Error('no signing key for this id_token');
    return createPublicKey({ key: jwk as JsonWebKeyInput['key'], format: 'jwk' });
  };
}

/**
 * The genericOAuth plugin for these settings and the discovery document
 * fetched for them (discoverOidc: the issuer checked, endpoints https, a time
 * limit). Better Auth gets the endpoints, so it fetches nothing at start-up
 * and a slow issuer can hold up nothing; the id_token check (signature
 * against the service's keys, issuer, audience, expiry, nonce) is set on the
 * provider here, and Better Auth runs it before getUserInfo.
 */
export function oidcPlugin(settings: OidcSettings, discovery: OidcDiscovery): BetterAuthPlugin {
  const plugin = genericOAuth({
    config: [{
      providerId: OIDC_PROVIDER_ID,
      name: settings.name,
      authorizationUrl: discovery.authorizationEndpoint,
      tokenUrl: discovery.tokenEndpoint,
      ...(discovery.userinfoEndpoint ? { userInfoUrl: discovery.userinfoEndpoint } : {}),
      clientId: settings.clientId,
      ...(settings.clientSecret ? { clientSecret: settings.clientSecret } : { tokenEndpointAuth: { method: 'none' as const } }),
      scopes: ['openid', 'email', 'profile', ...(settings.joinEnabled && settings.joinGroup ? ['groups'] : [])],
      pkce: true,
      disableImplicitSignUp: true,
      overrideUserInfo: false,
      // the issuer is part of the key: an old-issuer identity never matches a new-issuer account
      accountSubject: ({ profile }) => oidcAccountKey(String(profile['iss'] ?? ''), String(profile['sub'] ?? '')),
      getUserInfo: async (tokens) => {
        const profile = await profileFromTokens(tokens, settings.issuer, discovery.userinfoEndpoint);
        return profile as never;
      },
    }],
  }) as unknown as BetterAuthPlugin;
  const init = plugin.init!;
  const jwks = remoteKeys(discovery.jwksUri);
  plugin.init = async (ctx) => {
    const result = (await init(ctx)) as { context?: { socialProviders?: Array<Record<string, unknown> & { id: string }> } } | undefined;
    const mine = result?.context?.socialProviders?.find((p) => p.id === OIDC_PROVIDER_ID);
    if (!mine) throw new Error('the login service provider was not built');
    mine['issuer'] = settings.issuer;
    mine['idToken'] = {
      jwks: (header: { kid?: string | undefined }) => jwks(header),
      issuer: settings.issuer,
      audience: settings.clientId,
      algorithms: discovery.signingAlgs,
    };
    mine['requiresIdTokenNonce'] = true;
    return result as never;
  };
  return plugin;
}
