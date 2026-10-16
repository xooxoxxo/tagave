/**
 * Music Connections linking (spec §2): tagave as an OAuth 2.0 provider
 * (authorization code + PKCE S256, refresh rotation, RFC 7009 revoke), so a
 * person can let another music app read their ratings, collection, listens
 * and identity. Better Auth 1.7 ships no OAuth-provider plugin, so these are
 * tagave's own routes; Better Auth supplies the session the consent page needs.
 *
 *   POST /api/v1/connect/register                 dynamic registration (RFC 7591 subset), allow-listed redirect hosts
 *   GET  /api/v1/connect/authorize                validates, then sends the browser to the consent page
 *   GET  /api/v1/connect/requests/:id             the consent page's view of one request (signed in)
 *   POST /api/v1/connect/requests/:id/decision    approve or deny it → where the browser goes next (signed in)
 *   POST /api/v1/connect/token                    code and refresh grants (client authenticates)
 *   POST /api/v1/connect/revoke                   RFC 7009 (client authenticates)
 *
 * No userinfo or end-session endpoint exists (both answer 404): tagave
 * issues no ID tokens, and identity data is the identity:read feed.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { readBuildInfo } from '@tagave/core';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { RateLimiter } from '../lib/rateLimit.js';
import {
  ACCESS_TOKEN_TTL_S,
  CODE_TTL_S,
  OFFLINE_ACCESS,
  REFRESH_TOKEN_TTL_S,
  REQUEST_TTL_S,
  ROTATED_KEEP_DAYS,
  PROTOCOL,
  SCOPE_LABELS,
  TAGAVE_CONSUMES,
  TAGAVE_PROVIDES,
  checkRequestedScopes,
  hashToken,
  isAllowedRedirect,
  newSecret,
  parseTrustedHosts,
  pkceChallenge,
  tokenMatches,
} from '../lib/mcOAuth.js';

const registrations = new RateLimiter(10, 60_000);
const tokenCalls = new RateLimiter(60, 60_000);
const authorizeCalls = new RateLimiter(60, 60_000);

export function resetConnectRouteLimits(): void {
  registrations.reset();
  tokenCalls.reset();
  authorizeCalls.reset();
}

/** Settings read per call, so tests (and a restart) can change them. */
export const connectConfig = {
  trustedHosts: (): string[] => parseTrustedHosts(process.env['MC_TRUSTED_PUBLIC_HOSTS']),
  /** The advisory-lock wait around a refresh before it answers 503. */
  lockTimeoutMs: 5000,
};

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const REQUEST_ID_RE = /^mcq_[A-Za-z0-9_-]{43}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

type OAuthError = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'temporarily_unavailable' | 'server_error';

function oauthError(reply: FastifyReply, status: number, error: OAuthError, description?: string): FastifyReply {
  reply.headers(NO_STORE);
  return reply.status(status).send(description ? { error, error_description: description } : { error });
}

type Sql = postgres.Sql | postgres.TransactionSql;

async function audit(sql: Sql, action: string, actorUserId: string | null, payload: Record<string, unknown>): Promise<void> {
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
            values (null, ${actorUserId}, ${action}, 'mc_client', ${sql.json(payload as never)})`;
}

// ── Request parsing ────────────────────────────────────────────────────────

type Params = Record<string, string>;

/** Query or form pairs; null when any name repeats (no request is read two ways). */
function uniquePairs(search: URLSearchParams): Params | null {
  const out: Params = {};
  for (const [k, v] of search) {
    if (Object.hasOwn(out, k)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * The token and revoke body, form-encoded (the standard) or JSON, with the
 * client credentials from HTTP Basic or the body (not both, unless they agree).
 */
function tokenParams(request: FastifyRequest): Params | null {
  let out: Params | null;
  const body = request.body;
  if (typeof body === 'string') {
    out = uniquePairs(new URLSearchParams(body));
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    out = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
  } else {
    out = body === undefined || body === null ? {} : null;
  }
  if (!out) return null;
  const authz = request.headers.authorization;
  if (authz) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authz);
    if (!m) return null;
    let id: string;
    let secret: string;
    try {
      const raw = Buffer.from(m[1]!, 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i < 0) return null;
      id = decodeURIComponent(raw.slice(0, i));
      secret = decodeURIComponent(raw.slice(i + 1));
    } catch {
      return null;
    }
    if ((out['client_id'] !== undefined && out['client_id'] !== id) || (out['client_secret'] !== undefined && out['client_secret'] !== secret)) return null;
    out['client_id'] = id;
    out['client_secret'] = secret;
  }
  return out;
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string;
  name: string;
  redirect_uri: string;
}

async function findClient(sql: Sql, clientId: string | undefined): Promise<ClientRow | null> {
  if (!clientId || clientId.length > 100) return null;
  const [row] = await sql<ClientRow[]>`
    select client_id, client_secret_hash, name, redirect_uri from mc_oauth_clients
     where client_id = ${clientId} and disabled_at is null`;
  return row ?? null;
}

/** The client named in `params`, when its secret is right. */
async function authenticateClient(sql: Sql, params: Params): Promise<ClientRow | null> {
  const client = await findClient(sql, params['client_id']);
  const secret = params['client_secret'];
  if (!client || !secret || secret.length > 200) return null;
  return tokenMatches(secret, client.client_secret_hash) ? client : null;
}

function invalidClient(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  if (request.headers.authorization) reply.header('www-authenticate', 'Basic realm="tagave"');
  return oauthError(reply, 401, 'invalid_client');
}

// ── Token issue ────────────────────────────────────────────────────────────

interface Issued {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

async function issueTokens(tx: Sql, grant: { familyId: string; clientId: string; userId: string; scopes: string[] }): Promise<Issued> {
  const access = newSecret('mca');
  const refresh = grant.scopes.includes(OFFLINE_ACCESS) ? newSecret('mcr') : null;
  await tx`insert into mc_oauth_tokens
      (family_id, client_id, user_id, scopes, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
    values (${grant.familyId}, ${grant.clientId}, ${grant.userId}, ${grant.scopes},
      ${hashToken(access)}, now() + make_interval(secs => ${ACCESS_TOKEN_TTL_S}),
      ${refresh ? hashToken(refresh) : null}, ${refresh ? tx`now() + make_interval(secs => ${REFRESH_TOKEN_TTL_S})` : null})`;
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    ...(refresh ? { refresh_token: refresh } : {}),
    scope: grant.scopes.join(' '),
  };
}

async function revokeFamily(tx: Sql, familyId: string): Promise<number> {
  const rows = await tx`update mc_oauth_tokens set revoked_at = now() where family_id = ${familyId} and revoked_at is null returning id`;
  return rows.length;
}

type GrantResult = { ok: true; body: Issued } | { ok: false; error: OAuthError; status?: number };

async function codeGrant(sql: postgres.Sql, client: ClientRow, params: Params): Promise<GrantResult> {
  const code = params['code'];
  const verifier = params['code_verifier'];
  const redirectUri = params['redirect_uri'];
  if (!code || !verifier || !redirectUri) return { ok: false, error: 'invalid_request' };
  if (code.length > 200 || !VERIFIER_RE.test(verifier)) return { ok: false, error: 'invalid_grant' };
  return sql.begin(async (tx): Promise<GrantResult> => {
    const [req] = await tx<Array<{ id: string; client_id: string; redirect_uri: string; scopes: string[]; code_challenge: string;
      user_id: string; family_id: string; code_used_at: Date | null; fresh: boolean; active: boolean }>>`
      select r.id, r.client_id, r.redirect_uri, r.scopes, r.code_challenge, r.user_id, r.family_id, r.code_used_at,
             r.code_expires_at > now() as fresh,
             (u.disabled_at is null and u.removed_at is null) as active
        from mc_oauth_requests r join users u on u.id = r.user_id
       where r.code_hash = ${hashToken(code)}
       for update of r`;
    if (!req || req.client_id !== client.client_id) return { ok: false, error: 'invalid_grant' };
    if (req.code_used_at) {
      // A code presented twice: whatever it was exchanged for is revoked (RFC 6749 §4.1.2).
      const n = await revokeFamily(tx, req.family_id);
      await audit(tx, 'mc.code.reuse', req.user_id, { client_id: client.client_id, revoked: n });
      return { ok: false, error: 'invalid_grant' };
    }
    if (!req.fresh || !req.active || req.redirect_uri !== redirectUri || pkceChallenge(verifier) !== req.code_challenge) {
      return { ok: false, error: 'invalid_grant' };
    }
    await tx`update mc_oauth_requests set code_used_at = now() where id = ${req.id}`;
    const body = await issueTokens(tx, { familyId: req.family_id, clientId: client.client_id, userId: req.user_id, scopes: req.scopes });
    return { ok: true, body };
  });
}

class LockTimeout extends Error {}

/**
 * Tagave's refresh grant: each refresh token works once and is replaced. The
 * request takes a transaction-scoped advisory lock on the token's hash (waiting
 * at most connectConfig.lockTimeoutMs), so two refreshes of the same token run
 * one after the other and the second sees the first one's rotation: that is
 * reuse, and the whole family (every token of that approval) is revoked.
 */
async function refreshGrant(sql: postgres.Sql, client: ClientRow, params: Params): Promise<GrantResult> {
  const refresh = params['refresh_token'];
  if (!refresh) return { ok: false, error: 'invalid_request' };
  if (refresh.length > 200) return { ok: false, error: 'invalid_grant' };
  const hash = hashToken(refresh);
  // Unknown tokens never take a lock.
  const known = await sql`select 1 from mc_oauth_tokens where refresh_token_hash = ${hash}`;
  if (known.length === 0) return { ok: false, error: 'invalid_grant' };
  try {
    return await sql.begin(async (tx): Promise<GrantResult> => {
      await tx.unsafe(`set local lock_timeout = '${Math.max(1, Math.floor(connectConfig.lockTimeoutMs))}ms'`);
      await tx`select pg_advisory_xact_lock(hashtextextended(${`mc-refresh:${hash}`}, 0))`;
      const [row] = await tx<Array<{ id: string; family_id: string; client_id: string; user_id: string; scopes: string[];
        rotated_at: Date | null; revoked_at: Date | null; fresh: boolean; active: boolean }>>`
        select t.id, t.family_id, t.client_id, t.user_id, t.scopes, t.rotated_at, t.revoked_at,
               t.refresh_expires_at > now() as fresh,
               (u.disabled_at is null and u.removed_at is null) as active
          from mc_oauth_tokens t join users u on u.id = t.user_id
         where t.refresh_token_hash = ${hash}`;
      if (!row) return { ok: false, error: 'invalid_grant' };
      // Another client's token: refused without touching it.
      if (row.client_id !== client.client_id) {
        await audit(tx, 'mc.refresh.failed', row.user_id, { client_id: client.client_id, reason: 'other_client' });
        return { ok: false, error: 'invalid_grant' };
      }
      if (row.rotated_at) {
        const n = await revokeFamily(tx, row.family_id);
        await audit(tx, 'mc.refresh.reuse', row.user_id, { client_id: client.client_id, revoked: n });
        return { ok: false, error: 'invalid_grant' };
      }
      if (row.revoked_at || !row.fresh || !row.active) {
        const reason = row.revoked_at ? 'revoked' : !row.fresh ? 'expired' : 'account_inactive';
        await audit(tx, 'mc.refresh.failed', row.user_id, { client_id: client.client_id, reason });
        return { ok: false, error: 'invalid_grant' };
      }
      const asked = params['scope'];
      if (asked !== undefined) {
        const wanted = asked.split(' ').filter(Boolean);
        if (!wanted.every((s) => row.scopes.includes(s))) return { ok: false, error: 'invalid_scope' };
      }
      await tx`update mc_oauth_tokens set rotated_at = now() where id = ${row.id}`;
      const body = await issueTokens(tx, { familyId: row.family_id, clientId: row.client_id, userId: row.user_id, scopes: row.scopes });
      await tx`delete from mc_oauth_tokens
                where family_id = ${row.family_id} and rotated_at < now() - make_interval(days => ${ROTATED_KEEP_DAYS})`;
      return { ok: true, body };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') throw new LockTimeout();
    throw err;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function createConnectRoutes(fastify: FastifyInstance) {
  // The token and revoke endpoints take form bodies (RFC 6749 §4.1.3), parsed by tokenParams.
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => done(null, body));

  fastify.post('/connect/register', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    registrations.check(`ip:${request.ip}`);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const uris = body['redirect_uris'];
    const name = body['client_name'];
    // Exactly one redirect URI: the consent page names its host, so it must be where the code goes.
    if (!Array.isArray(uris) || uris.length !== 1 || !isAllowedRedirect(uris[0], connectConfig.trustedHosts())) {
      return reply.status(400).send({ error: 'invalid_redirect_uri', error_description: 'One redirect URI on a private network, or https on a trusted host (MC_TRUSTED_PUBLIC_HOSTS)' });
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      return reply.status(400).send({ error: 'invalid_client_metadata', error_description: 'client_name: 1 to 100 characters' });
    }
    for (const [key, allowed] of [['grant_types', ['authorization_code', 'refresh_token']], ['response_types', ['code']]] as const) {
      const v = body[key];
      if (v !== undefined && (!Array.isArray(v) || !v.every((x) => (allowed as readonly unknown[]).includes(x)))) {
        return reply.status(400).send({ error: 'invalid_client_metadata', error_description: `${key}: only ${allowed.join(', ')}` });
      }
    }
    const method = body['token_endpoint_auth_method'] ?? 'client_secret_basic';
    if (method !== 'client_secret_basic' && method !== 'client_secret_post') {
      return reply.status(400).send({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method: client_secret_basic or client_secret_post' });
    }
    const { sql } = getAuthHandle();
    const clientId = newSecret('mcc');
    const secret = newSecret('mcs');
    const redirectUri = uris[0] as string;
    const clientName = name.trim();
    await sql.begin(async (tx) => {
      await tx`insert into mc_oauth_clients (client_id, client_secret_hash, name, redirect_uri)
               values (${clientId}, ${hashToken(secret)}, ${clientName}, ${redirectUri})`;
      await audit(tx, 'mc.client.register', null, { client_id: clientId, client_name: clientName, redirect_host: new URL(redirectUri).host });
    });
    request.log.info({ event: 'mc.client.register', clientId, redirectHost: new URL(redirectUri).host }, 'music connections client registered');
    reply.headers(NO_STORE);
    return reply.status(201).send({
      client_id: clientId,
      client_secret: secret,
      client_secret_expires_at: 0,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    });
  });

  // Errors answer 400 here and never redirect: the browser goes to a
  // client's redirect URI only after the person decides on the consent page.
  fastify.get('/connect/authorize', async (request, reply) => {
    authorizeCalls.check(`ip:${request.ip}`);
    const bad = (description: string) => reply.status(400).send({ error: 'invalid_request', error_description: description });
    const q = uniquePairs(new URLSearchParams(request.url.split('?')[1] ?? ''));
    if (!q) return bad('a parameter was given more than once');
    const { sql } = getAuthHandle();
    const client = await findClient(sql, q['client_id']);
    if (!client) return reply.status(400).send({ error: 'invalid_client', error_description: 'unknown client_id' });
    if (q['redirect_uri'] !== client.redirect_uri) return bad('redirect_uri does not match the registered one');
    if (q['response_type'] !== 'code') return reply.status(400).send({ error: 'unsupported_response_type' });
    const scopes = checkRequestedScopes(q['scope']);
    if (!scopes.ok) return reply.status(400).send({ error: 'invalid_scope', error_description: scopes.reason });
    if (q['code_challenge_method'] !== 'S256' || !CHALLENGE_RE.test(q['code_challenge'] ?? '')) return bad('PKCE with S256 is required');
    const state = q['state'];
    if (state !== undefined && state.length > 512) return bad('state is too long');
    const id = newSecret('mcq');
    await sql`delete from mc_oauth_requests where expires_at < now() - interval '1 day'`;
    await sql`insert into mc_oauth_requests (id, client_id, redirect_uri, scopes, state, code_challenge, expires_at)
              values (${id}, ${client.client_id}, ${client.redirect_uri}, ${scopes.scopes}, ${state ?? null}, ${q['code_challenge']!},
                      now() + make_interval(secs => ${REQUEST_TTL_S}))`;
    reply.headers(NO_STORE);
    return reply.redirect(`/connect/consent?request=${encodeURIComponent(id)}`, 302);
  });

  const openRequest = async (sql: Sql, params: unknown) => {
    const { id } = params as { id: string };
    if (!REQUEST_ID_RE.test(id)) return null;
    const [row] = await sql<Array<{ id: string; client_id: string; name: string; redirect_uri: string; scopes: string[]; state: string | null }>>`
      select r.id, r.client_id, c.name, r.redirect_uri, r.scopes, r.state
        from mc_oauth_requests r join mc_oauth_clients c on c.client_id = r.client_id
       where r.id = ${id} and r.decided_at is null and r.expires_at > now() and c.disabled_at is null`;
    return row ?? null;
  };
  const gone = () => new ApiError(404, 'Not Found', 'This link request has expired or was already answered. Start the link again from the other app.');

  fastify.get('/connect/requests/:id', async (request, reply) => {
    const row = await openRequest(getAuthHandle().sql, request.params);
    if (!row) throw gone();
    reply.headers(NO_STORE);
    const target = new URL(row.redirect_uri);
    return {
      client: { name: row.name, redirectHost: target.host, secure: target.protocol === 'https:' },
      scopes: row.scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] ?? scope })),
    };
  });

  fastify.post('/connect/requests/:id/decision', async (request, reply) => {
    const user = request.user!;
    const { sql, env } = getAuthHandle();
    // A browser sends Origin on this POST; it must be tagave's own page.
    const origin = request.headers.origin;
    if (origin !== undefined && !env.trustedOrigins.includes(origin)) throw new ApiError(403, 'Forbidden', 'Approve the link on tagave itself.');
    const decision = (request.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== 'approve' && decision !== 'deny') throw new ApiError(400, 'Bad Request', 'decision: approve or deny');
    const { id } = request.params as { id: string };
    if (!REQUEST_ID_RE.test(id)) throw gone();
    const code = newSecret('mcx');
    const familyId = randomUUID();
    const result = await sql.begin(async (tx) => {
      const [row] = await tx<Array<{ client_id: string; name: string; redirect_uri: string; scopes: string[]; state: string | null }>>`
        update mc_oauth_requests r
           set decided_at = now(), user_id = ${user.id},
               code_hash = ${decision === 'approve' ? hashToken(code) : null},
               code_expires_at = ${decision === 'approve' ? tx`now() + make_interval(secs => ${CODE_TTL_S})` : null},
               family_id = ${decision === 'approve' ? familyId : null}
          from mc_oauth_clients c
         where r.id = ${id} and c.client_id = r.client_id and c.disabled_at is null
           and r.decided_at is null and r.expires_at > now()
        returning r.client_id, c.name, r.redirect_uri, r.scopes, r.state`;
      if (!row) return null;
      await audit(tx, decision === 'approve' ? 'mc.link.approve' : 'mc.link.deny', user.id, {
        client_id: row.client_id,
        client_name: row.name,
        redirect_host: new URL(row.redirect_uri).host,
        scopes: row.scopes,
      });
      return row;
    });
    if (!result) throw gone();
    const target = new URL(result.redirect_uri);
    if (decision === 'approve') target.searchParams.set('code', code);
    else target.searchParams.set('error', 'access_denied');
    if (result.state !== null) target.searchParams.set('state', result.state);
    request.log.info({ event: decision === 'approve' ? 'mc.link.approve' : 'mc.link.deny', userId: user.id, clientId: result.client_id }, 'music connections link decided');
    reply.headers(NO_STORE);
    return { redirect: target.toString() };
  });

  fastify.post('/connect/token', async (request, reply) => {
    tokenCalls.check(`ip:${request.ip}`);
    const params = tokenParams(request);
    if (!params) return oauthError(reply, 400, 'invalid_request');
    const { sql } = getAuthHandle();
    const client = await authenticateClient(sql, params);
    if (!client) return invalidClient(reply, request);
    let result: GrantResult;
    try {
      if (params['grant_type'] === 'authorization_code') result = await codeGrant(sql, client, params);
      else if (params['grant_type'] === 'refresh_token') result = await refreshGrant(sql, client, params);
      else return oauthError(reply, 400, params['grant_type'] ? 'unsupported_grant_type' : 'invalid_request');
    } catch (err) {
      if (err instanceof LockTimeout) {
        reply.header('retry-after', '1');
        return oauthError(reply, 503, 'temporarily_unavailable');
      }
      throw err;
    }
    if (!result.ok) return oauthError(reply, result.status ?? 400, result.error);
    reply.headers(NO_STORE);
    return reply.send(result.body);
  });

  fastify.post('/connect/revoke', async (request, reply) => {
    tokenCalls.check(`ip:${request.ip}`);
    const params = tokenParams(request);
    if (!params) return oauthError(reply, 400, 'invalid_request');
    const { sql } = getAuthHandle();
    const client = await authenticateClient(sql, params);
    if (!client) return invalidClient(reply, request);
    const token = params['token'];
    if (!token) return oauthError(reply, 400, 'invalid_request');
    if (token.length <= 200) {
      const h = hashToken(token);
      await sql.begin(async (tx) => {
        const [row] = await tx<Array<{ family_id: string; user_id: string }>>`
          select family_id, user_id from mc_oauth_tokens
           where client_id = ${client.client_id} and (access_token_hash = ${h} or refresh_token_hash = ${h})
           limit 1`;
        if (!row) return;
        // The link is gone: every access and refresh token of that approval.
        const n = await revokeFamily(tx, row.family_id);
        if (n > 0) await audit(tx, 'mc.link.revoke', row.user_id, { client_id: client.client_id, revoked: n });
      });
    }
    // RFC 7009 §2.2: 200 whether or not the token was known.
    reply.headers(NO_STORE);
    return reply.status(200).send({});
  });
}

/** Where each capability's feed lives (served by the /mc/v1 routes). */
export const feedPath = (capability: string): string => `/mc/v1/${capability}`;

/**
 * GET /.well-known/music-connections: what tagave offers and reads, and where
 * to link (spec §2, Discovery). Public and outside /api, so the route guard
 * does not see it. The auth endpoints are absolute, on PUBLIC_URL.
 */
export async function createManifestRoute(fastify: FastifyInstance) {
  fastify.get('/.well-known/music-connections', async (_request, reply) => {
    const origin = getAuthHandle().env.publicUrl.origin;
    reply.header('cache-control', 'public, max-age=300');
    return {
      protocol: PROTOCOL,
      service: 'tagave',
      version: readBuildInfo().version,
      auth: {
        authorize: `${origin}/api/v1/connect/authorize`,
        token: `${origin}/api/v1/connect/token`,
        register: `${origin}/api/v1/connect/register`,
      },
      provides: Object.fromEntries(TAGAVE_PROVIDES.map((c) => [c, feedPath(c)])),
      consumes: [...TAGAVE_CONSUMES],
    };
  });
}
