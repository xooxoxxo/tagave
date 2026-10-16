/**
 * Settings › Connections (Music Connections spec §2 Linking, §4 Consumer
 * side, §5): tagave as a client. A person links tagave to another music app
 * (review-gatherer, another tagave) and tagave pulls that app's feeds.
 *
 *   GET    /api/v1/me/connections                  the person's links, and this tagave's address (link back)
 *   POST   /api/v1/me/connections                  { url } → { authorizeUrl }: manifest, registration, PKCE
 *   GET    /api/v1/me/connections/callback         the remote sends the browser back here → Settings › Connections
 *   POST   /api/v1/me/connections/:id/sync         Sync now: queue a pull of this link
 *   POST   /api/v1/me/connections/:id/reapprove    → { authorizeUrl }: the approval again, cursors kept
 *   PATCH  /api/v1/me/connections/:id              { url }: the remote moved; cursors kept, tokens dropped
 *   DELETE /api/v1/me/connections/:id              revoke (at the remote too); a revoked link: remove it
 *
 * Every route acts on the signed-in person's own links only ('self').
 *
 * Outbound requests go only to the linked remote's own origin, through the
 * allow-list (@tagave/core/mc): the manifest is refused when any endpoint it
 * names sits elsewhere, so no token or secret leaves for another host.
 * Tokens and client secrets are sealed (APP_SECRET) and never logged, put in
 * a URL or echoed in an error; failures carry fixed reasons only.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { ManifestSchema, type Manifest } from 'music-connections';
import {
  LinkError,
  availableUngranted,
  capabilityScopes,
  endpointsOf,
  expiryFrom,
  fetchRemoteManifest,
  linkScopes,
  networkReason,
  openOne,
  openTokens,
  readJson,
  revokeAtRemote,
  rfetch,
  sealOne,
  sealTokens,
  sharedCapabilities,
} from '@tagave/core/mc';
import { mcEnabled, mcLinkAudit, unplugLinkTx } from '@tagave/db';
import { mcRemoteUrlSchema, type McCapabilityView, type McConnectionsView, type McLinkErrorCode, type McLinkView, type McStartView } from '@tagave/shared';
import { readScope } from 'music-connections';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import type { PgBoss } from 'pg-boss';
import { RateLimiter } from '../lib/rateLimit.js';

type Sql = postgres.Sql;

/** An authorization in flight lives this long. */
export const PENDING_TTL_MS = 15 * 60 * 1000;
/** A link whose pulls have failed for longer than this shows the remote as down (spec §5). */
export const DOWN_AFTER_MS = 24 * 3600 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Add, Re-approve and Edit URL each make tagave fetch an address: 10 per 10 minutes per person.
const starts = new RateLimiter(10, 10 * 60_000);
const syncs = new RateLimiter(1, 60_000);
export function resetConnectionRouteLimits(): void {
  starts.reset();
  syncs.reset();
}

/** A waiting pull that starts within this long runs now ("already syncing"). */
const STARTS_NOW_MS = 5_000;

export type EnqueueResult = { queued: true } | { queued: false; retryAt: string };

/**
 * Queue a pull of one link to run now. A backoff retry waiting with the same
 * singletonKey would make the send a no-op, so delayed ones (created or
 * retry, start time in the future) are removed first, through pg-boss's own
 * findJobs and deleteJob; a running job is never touched. If a job still
 * holds the key (one queued to run now), the answer says when it starts.
 */
export async function enqueueLinkPull(boss: Pick<PgBoss, 'send' | 'findJobs' | 'deleteJob'>, linkId: string): Promise<EnqueueResult> {
  const key = `connections.pull:${linkId}`;
  const waiting = async () => (await boss.findJobs('connections.pull', { key, queued: true }))
    .filter((j) => (j.state === 'created' || j.state === 'retry') && j.singletonKey === key)
    .map((j) => ({ id: j.id, startAfter: new Date(j.startAfter) }))
    .sort((x, y) => x.startAfter.getTime() - y.startAfter.getTime());
  // a job due within a few seconds already runs now (database and process clocks differ slightly)
  const soon = Date.now() + STARTS_NOW_MS;
  const delayed = (await waiting()).filter((j) => j.startAfter.getTime() > soon).map((j) => j.id);
  if (delayed.length > 0) await boss.deleteJob('connections.pull', delayed);
  const id = await boss.send('connections.pull', { linkId }, { singletonKey: key });
  if (id) return { queued: true };
  const [first] = await waiting();
  return { queued: false, retryAt: (first?.startAfter ?? new Date(Date.now() + 60_000)).toISOString() };
}

/** Swappable for tests: how Sync now and a fresh approval queue a pull. */
export const mcConnectionsConfig = {
  enqueuePull: async (linkId: string): Promise<EnqueueResult> => enqueueLinkPull(await getBoss(), linkId),
};

interface LinkRow {
  id: string;
  user_id: string;
  remote_url: string;
  manifest: unknown;
  client_id: string;
  sealed_tokens: string;
  scopes: string[];
  requested_scopes: string[];
  state: 'active' | 'needs_reapproval' | 'revoked';
  last_sync_at: Date | null;
  last_attempt_at: Date | null;
  last_error: string | null;
  failures: number;
  next_attempt_at: Date | null;
  last_counts: Record<string, { applied?: number; skipped?: number }> | null;
  created_at: Date;
}

const callbackUrl = (): string => new URL('/api/v1/me/connections/callback', getAuthHandle().env.publicUrl.origin).href;
const appSecret = (): string => getAuthHandle().env.appSecret;
/** mc_pending is keyed by the state's hash: the state itself only travels in URLs. */
const stateHash = (state: string): string => createHash('sha256').update(state, 'utf8').digest('hex');

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A mutating call from a browser must come from tagave's own page. */
export function sameSite(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin !== undefined && !getAuthHandle().env.trustedOrigins.includes(origin)) {
    throw new ApiError(403, 'Forbidden', 'Change your connections on tagave itself.');
  }
}

async function ownLink(sql: Sql, userId: string, id: string): Promise<LinkRow> {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'Not Found', 'No such connection.');
  const [row] = await sql<LinkRow[]>`select * from mc_links where id = ${id} and user_id = ${userId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'No such connection.');
  return row;
}

/** Music Connections off (Settings › Modules): nothing new is linked or pulled; the links stay. */
async function requireOn(): Promise<void> {
  if (!(await mcEnabled(getAuthHandle().sql))) throw new ApiError(409, 'Conflict', 'Music Connections is turned off. The owner turns it on in Settings › Modules.');
}

export const COULD_NOT_REACH = 'Could not reach a Music Connections service at that address.';

/**
 * What the person who typed the address sees. Only what is decided without
 * touching the network (the address itself) or after a valid manifest came
 * back is said in words; every failure on the way there reads the same, so
 * the page cannot be used to map what answers on the network. The reason
 * itself goes to the server log only.
 */
function linkProblem(err: unknown): ApiError {
  const reason = err instanceof LinkError ? err.message : '';
  const said: Record<string, string> = {
    'invalid url': 'That is not a web address. Paste the other app’s address, for example http://192.168.1.20:8080.',
    'remote not allowed': 'tagave links only to apps on your network (a LAN or tailnet address) or, over https, to a host the owner trusts (MC_TRUSTED_PUBLIC_HOSTS).',
    'nothing to share': 'The other app offers nothing tagave reads (critic scores, identity or wantlist suggestions).',
    'different service': 'A different app answers at the new address. Link it as a new connection instead.',
  };
  return new ApiError(400, 'Bad Request', said[reason] ?? COULD_NOT_REACH);
}

/**
 * Fetch the manifest, register tagave as a client, keep the authorization in
 * flight and return where to send the browser. Used by Add and Re-approve.
 */
async function startLink(sql: Sql, userId: string, rawUrl: string, log: FastifyRequest['log']): Promise<McStartView> {
  let host = hostOf(rawUrl);
  try {
    const { origin, manifest, endpoints } = await fetchRemoteManifest(rawUrl);
    host = new URL(origin).host;
    const scopes = linkScopes(manifest);
    if (scopes.length === 0) throw new LinkError('nothing to share');

    let reg: Response;
    try {
      reg = await rfetch(endpoints.register, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'tagave',
          redirect_uris: [callbackUrl()],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      });
    } catch (err) {
      throw new LinkError(networkReason(err, 'registration refused'));
    }
    if (!reg.ok) {
      await reg.body?.cancel().catch(() => undefined);
      throw new LinkError('registration refused');
    }
    const r = (await readJson(reg)) as { client_id?: unknown; client_secret?: unknown };
    if (typeof r.client_id !== 'string' || typeof r.client_secret !== 'string' || !r.client_id || !r.client_secret
      || r.client_id.length > 512 || r.client_secret.length > 512) {
      throw new LinkError('registration invalid');
    }

    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    await sql`delete from mc_pending where created_at < now() - make_interval(secs => ${PENDING_TTL_MS / 1000})`;
    await sql`insert into mc_pending (state_hash, user_id, remote_url, manifest, client_id, code_verifier_sealed, client_secret_sealed, requested_scopes)
              values (${stateHash(state)}, ${userId}, ${origin}, ${sql.json(manifest as never)}, ${r.client_id}, ${sealOne(verifier, appSecret())},
                      ${sealOne(r.client_secret, appSecret())}, ${capabilityScopes(scopes)})`;
    const authorize = new URL(endpoints.authorize);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: r.client_id,
      redirect_uri: callbackUrl(),
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    log.info({ event: 'mc.link.start', userId, remoteHost: host, scopes }, 'music connections link started');
    return { authorizeUrl: authorize.href };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Whatever went wrong on the way (a broken body, a stream reset, a bug)
    // reads as the generic problem: the reason goes to the log only.
    if (err instanceof LinkError) log.info({ event: 'mc.link.start_failed', userId, remoteHost: host, reason: err.message }, 'music connections link refused');
    else log.warn({ event: 'mc.link.start_failed', userId, remoteHost: host, err: (err as Error)?.name }, 'music connections link failed unexpectedly');
    throw linkProblem(err);
  }
}

function capabilitiesOf(row: LinkRow): McCapabilityView[] {
  const m = ManifestSchema.safeParse(row.manifest);
  if (!m.success) return [];
  const fresh = new Set<string>(availableUngranted(m.data, row.scopes));
  return sharedCapabilities(m.data).map((cap) => {
    const counts = row.last_counts?.[cap];
    const status: McCapabilityView['status'] = row.scopes.includes(readScope(cap))
      ? 'granted'
      : fresh.has(cap) && !row.requested_scopes.includes(readScope(cap)) ? 'available' : 'not_granted';
    return {
      capability: cap,
      status,
      applied: typeof counts?.applied === 'number' ? counts.applied : null,
      skipped: typeof counts?.skipped === 'number' ? counts.skipped : null,
    };
  });
}

export function linkView(row: LinkRow, now = Date.now()): McLinkView {
  const service = (row.manifest as { service?: unknown } | null)?.service;
  const since = (row.last_sync_at ?? row.created_at).getTime();
  return {
    id: row.id,
    remoteUrl: row.remote_url,
    service: typeof service === 'string' ? service : '',
    state: row.state,
    capabilities: capabilitiesOf(row),
    lastSyncAt: row.last_sync_at?.toISOString() ?? null,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastError: row.last_error,
    failures: row.failures,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    down: row.state === 'active' && row.failures > 0 && now - since > DOWN_AFTER_MS,
    createdAt: row.created_at.toISOString(),
  };
}

type TokenAnswer = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };

export async function createMcConnectionRoutes(fastify: FastifyInstance) {
  fastify.get('/me/connections', async (request): Promise<McConnectionsView> => {
    const user = request.user!;
    const { sql, env } = getAuthHandle();
    const rows = await sql<Array<LinkRow & { identity_conflicts: number; parked_dropped: number }>>`
      select l.*, (select count(*)::int from mc_identity i where i.link_id = l.id and i.state = 'conflict') as identity_conflicts
        from mc_links l where l.user_id = ${user.id} order by l.created_at, l.id`;
    return { links: rows.map((r) => ({ ...linkView(r), identityConflicts: r.identity_conflicts, parkedDropped: r.parked_dropped })), ownUrl: env.publicUrl.origin };
  });

  fastify.post('/me/connections', async (request): Promise<McStartView> => {
    const user = request.user!;
    sameSite(request);
    starts.check(`user:${user.id}`);
    const parsed = mcRemoteUrlSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'url is required');
    await requireOn();
    return startLink(getAuthHandle().sql, user.id, parsed.data.url, request.log);
  });

  fastify.post('/me/connections/:id/reapprove', async (request): Promise<McStartView> => {
    const user = request.user!;
    sameSite(request);
    starts.check(`user:${user.id}`);
    const { sql } = getAuthHandle();
    const link = await ownLink(sql, user.id, (request.params as { id: string }).id);
    await requireOn();
    return startLink(sql, user.id, link.remote_url, request.log);
  });

  // A page load: always answers with a redirect to Settings › Connections.
  fastify.get('/me/connections/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { sql } = getAuthHandle();
    const q = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const code = typeof q.code === 'string' ? q.code : '';
    const state = typeof q.state === 'string' ? q.state : '';
    const remoteError = typeof q.error === 'string' ? q.error : '';
    let host = '';
    reply.header('cache-control', 'no-store');
    const fail = (error: McLinkErrorCode, reason: string) => {
      request.log.info({ event: 'mc.link.failed', userId: user.id, remoteHost: host, reason }, 'music connections link failed');
      return reply.redirect(`/settings/connections?error=${error}`, 303);
    };
    if (!state) return fail(remoteError === 'access_denied' ? 'access_denied' : remoteError ? 'remote_error' : 'invalid_state', 'no state');
    if (state.length > 128) return fail('invalid_state', 'state too long');
    // Single use: the delete is the claim, bound to the signed-in person.
    const [p] = await sql<Array<{ remote_url: string; manifest: unknown; client_id: string; code_verifier_sealed: string; client_secret_sealed: string; requested_scopes: string[]; created_at: Date }>>`
      delete from mc_pending where state_hash = ${stateHash(state)} and user_id = ${user.id}
      returning remote_url, manifest, client_id, code_verifier_sealed, client_secret_sealed, requested_scopes, created_at`;
    if (!p) return fail('invalid_state', 'unknown or replayed state');
    host = hostOf(p.remote_url);
    if (p.created_at.getTime() < Date.now() - PENDING_TTL_MS) return fail('invalid_state', 'state expired');
    if (remoteError) return fail(remoteError === 'access_denied' ? 'access_denied' : 'remote_error', 'authorization error from remote');
    if (!code || code.length > 512) return fail('invalid_response', 'missing code');

    let manifest: Manifest;
    let tokenUrl: string;
    try {
      manifest = ManifestSchema.parse(p.manifest);
      tokenUrl = endpointsOf(manifest, p.remote_url).token;
    } catch {
      return fail('remote_error', 'token endpoint refused');
    }
    const clientSecret = openOne(p.client_secret_sealed, appSecret());
    const verifier = openOne(p.code_verifier_sealed, appSecret());
    if (!clientSecret || !verifier) return fail('invalid_state', 'pending secrets unreadable');

    let t: TokenAnswer;
    try {
      const res = await rfetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: callbackUrl(),
          client_id: p.client_id, client_secret: clientSecret, code_verifier: verifier,
        }).toString(),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return fail('remote_error', `token exchange refused (${res.status})`);
      }
      t = (await readJson(res)) as TokenAnswer;
    } catch (err) {
      return fail('remote_error', networkReason(err, 'token exchange failed'));
    }
    if (typeof t.access_token !== 'string' || !t.access_token || t.access_token.length > 2048) return fail('invalid_response', 'token response invalid');
    // RFC 6749 §5.1: no scope means the requested scope. Never more than tagave asked for.
    const granted = typeof t.scope === 'string' && t.scope ? t.scope.split(/\s+/) : p.requested_scopes;
    const scopes = capabilityScopes(granted).filter((s) => p.requested_scopes.includes(s));
    const sealed = sealTokens({
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : '',
      client_secret: clientSecret,
      access_expires_at: expiryFrom(t.expires_in),
    }, appSecret());

    const saved = await sql.begin(async (tx) => {
      const [prev] = await tx<Array<{ id: string; scopes: string[]; state: string; sealed_tokens: string; client_id: string; manifest: unknown }>>`
        select id, scopes, state, sealed_tokens, client_id, manifest from mc_links
         where user_id = ${user.id} and remote_url = ${p.remote_url} for update`;
      const [row] = await tx<Array<{ id: string }>>`
        insert into mc_links (user_id, remote_url, manifest, manifest_checked_at, client_id, sealed_tokens, scopes, requested_scopes, state)
        values (${user.id}, ${p.remote_url}, ${tx.json(manifest as never)}, now(), ${p.client_id}, ${sealed}, ${scopes}, ${p.requested_scopes}, 'active')
        on conflict (user_id, remote_url) do update
          set manifest = excluded.manifest, manifest_checked_at = now(), client_id = excluded.client_id,
              sealed_tokens = excluded.sealed_tokens, scopes = excluded.scopes, requested_scopes = excluded.requested_scopes,
              state = 'active', last_error = null, failures = 0, next_attempt_at = null, updated_at = now()
        returning id`;
      const linkId = row!.id;
      // A revoked row starts afresh: a new link, no scope diff against the old grant.
      const reapproval = !!prev && prev.state !== 'revoked';
      if (!reapproval) await mcLinkAudit(tx, { action: 'mc.consumer.link_create', userId: user.id, linkId, payload: { remote_host: host, service: manifest.service } });
      await mcLinkAudit(tx, { action: 'mc.consumer.link_approve', userId: user.id, linkId, payload: { remote_host: host, scopes } });
      if (reapproval) {
        const added = scopes.filter((s) => !prev.scopes.includes(s));
        const removed = prev.scopes.filter((s) => !scopes.includes(s));
        if (added.length || removed.length) {
          await mcLinkAudit(tx, { action: 'mc.consumer.scope_change', userId: user.id, linkId, payload: { remote_host: host, added, removed } });
        }
      }
      return { linkId, prev: reapproval ? prev : undefined };
    });
    // The approval before this one is spent: give its tokens back to the host that issued them.
    const old = saved.prev ? openTokens(saved.prev.sealed_tokens, appSecret()) : null;
    if (old && saved.prev) await revokeAtRemote({ remoteUrl: p.remote_url, manifest: saved.prev.manifest, clientId: saved.prev.client_id }, old);
    // The first pull runs now, replacing any backoff retry from before the re-approval.
    const first = await mcConnectionsConfig.enqueuePull(saved.linkId).catch((err: Error) => {
      request.log.warn({ err: err.message, linkId: saved.linkId }, 'first connections pull not queued; the 15-minute pull picks it up');
      return null;
    });
    if (first && !first.queued) request.log.info({ linkId: saved.linkId, retryAt: first.retryAt }, 'first connections pull already waiting');
    request.log.info({ event: 'mc.link.approved', userId: user.id, remoteHost: host, scopes }, 'music connections link approved');
    return reply.redirect(`/settings/connections?linked=${saved.linkId}`, 303);
  });

  fastify.post('/me/connections/:id/sync', async (request, reply) => {
    const user = request.user!;
    sameSite(request);
    const link = await ownLink(getAuthHandle().sql, user.id, (request.params as { id: string }).id);
    if (link.state !== 'active') throw new ApiError(409, 'Conflict', 'This connection needs approval again before it can sync.');
    await requireOn();
    syncs.check(`link:${link.id}`, Date.now(), 'Synced a moment ago. Try again in a minute.');
    const queued = await mcConnectionsConfig.enqueuePull(link.id);
    if (!queued.queued) {
      // Never a 202 that does nothing: say when the pull already waiting starts.
      const waitMs = Date.parse(queued.retryAt) - Date.now();
      reply.header('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000))));
      // About to run (or running): "already syncing"; later: when it starts.
      if (waitMs <= STARTS_NOW_MS) return reply.status(409).send({ title: 'Conflict', status: 409, detail: 'Already syncing.' });
      return reply.status(409).send({ title: 'Conflict', status: 409, detail: 'A sync of this connection is already waiting to run.', retryAt: queued.retryAt });
    }
    return reply.status(202).send({ status: 'queued' });
  });

  fastify.patch('/me/connections/:id', async (request): Promise<McLinkView> => {
    const user = request.user!;
    sameSite(request);
    starts.check(`user:${user.id}`);
    const { sql } = getAuthHandle();
    const link = await ownLink(sql, user.id, (request.params as { id: string }).id);
    if (link.state === 'revoked') throw new ApiError(409, 'Conflict', 'This connection was revoked. Add the new address as a new connection.');
    const parsed = mcRemoteUrlSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'url is required');
    let next: { origin: string; manifest: Manifest };
    try {
      next = await fetchRemoteManifest(parsed.data.url);
      // Cursors stay, so only the same service at its new address (cursor formats are per service).
      const prev = ManifestSchema.safeParse(link.manifest);
      if (prev.success && prev.data.service !== next.manifest.service) throw new LinkError('different service');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      request.log.info({ event: 'mc.link.url_change_failed', userId: user.id, linkId: link.id, reason: err instanceof LinkError ? err.message : (err as Error)?.name ?? 'unexpected error' }, 'music connections address not changed');
      throw linkProblem(err);
    }
    if (next.origin === link.remote_url) {
      const [row] = await sql<LinkRow[]>`update mc_links set manifest = ${sql.json(next.manifest as never)}, manifest_checked_at = now(), updated_at = now()
                                          where id = ${link.id} returning *`;
      return linkView(row!);
    }
    // Credentials never follow a new address: the same statement that moves
    // the link clears them (reading the old ones), and the new host must
    // approve again. Cursors are kept.
    let rows: Array<LinkRow & { old_remote_url: string; old_manifest: unknown; old_client_id: string; old_sealed_tokens: string }>;
    try {
      rows = await sql`
        with old as (select id, remote_url, manifest, client_id, sealed_tokens from mc_links
                      where id = ${link.id} and user_id = ${user.id} and state <> 'revoked' for update)
        update mc_links m
           set remote_url = ${next.origin}, manifest = ${sql.json(next.manifest as never)}, manifest_checked_at = now(),
               sealed_tokens = '', state = 'needs_reapproval', failures = 0, next_attempt_at = null, last_error = null, updated_at = now()
          from old where m.id = old.id
        returning m.*, old.remote_url as old_remote_url, old.manifest as old_manifest, old.client_id as old_client_id, old.sealed_tokens as old_sealed_tokens`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'Conflict', 'You already have a connection to that address.');
      throw err;
    }
    const row = rows[0];
    if (!row) throw new ApiError(404, 'Not Found', 'No such connection.');
    const oldTokens = openTokens(row.old_sealed_tokens, appSecret());
    if (oldTokens) await revokeAtRemote({ remoteUrl: row.old_remote_url, manifest: row.old_manifest, clientId: row.old_client_id }, oldTokens);
    await mcLinkAudit(sql, { action: 'mc.consumer.url_change', userId: user.id, linkId: link.id, payload: { old_host: hostOf(row.old_remote_url), new_host: hostOf(next.origin) } });
    request.log.info({ event: 'mc.link.url_changed', userId: user.id, linkId: link.id }, 'music connections address changed');
    return linkView(row);
  });

  fastify.delete('/me/connections/:id', async (request) => {
    const user = request.user!;
    sameSite(request);
    const { sql } = getAuthHandle();
    const link = await ownLink(sql, user.id, (request.params as { id: string }).id);
    if (link.state === 'revoked') {
      // Already revoked: Remove takes it off the list.
      await sql`delete from mc_links where id = ${link.id} and user_id = ${user.id} and state = 'revoked'`;
      return { ok: true, removed: true };
    }
    // Revoke here first, in one statement that also returns what it cleared:
    // a pull refreshing at the same moment can no longer write tokens back
    // (its save requires state 'active'). A later re-link starts afresh.
    // The same transaction deletes what the link brought (design §8): its rows
    // in every module table, its unconfirmed MBID fills and its undecided
    // identify-queue candidates. Accepted wantlist entries and confirmed
    // matches are the person's and stay.
    const { rows, removed } = await sql.begin(async (tx) => {
      const r = await tx<Array<{ remote_url: string; manifest: unknown; client_id: string; sealed_tokens: string; scopes: string[] }>>`
        with old as (select id, remote_url, manifest, client_id, sealed_tokens, scopes from mc_links
                      where id = ${link.id} and user_id = ${user.id} for update)
        update mc_links m
           set state = 'revoked', sealed_tokens = '', cursors = '{}'::jsonb, handler_versions = '{}'::jsonb,
               failures = 0, next_attempt_at = null, last_counts = null, updated_at = now()
          from old where m.id = old.id
        returning old.remote_url, old.manifest, old.client_id, old.sealed_tokens, old.scopes`;
      return { rows: r, removed: r.length > 0 ? await unplugLinkTx(tx, link.id, user.id) : null };
    });
    const old = rows[0];
    if (!old) throw new ApiError(404, 'Not Found', 'No such connection.');
    const tokens = openTokens(old.sealed_tokens, appSecret());
    if (tokens) await revokeAtRemote({ remoteUrl: old.remote_url, manifest: old.manifest, clientId: old.client_id }, tokens);
    await mcLinkAudit(sql, { action: 'mc.consumer.revoke', userId: user.id, linkId: link.id, payload: { remote_host: hostOf(old.remote_url), scopes: old.scopes, removed } });
    request.log.info({ event: 'mc.link.revoked', userId: user.id, linkId: link.id }, 'music connections link revoked');
    return { ok: true, removed: false };
  });
}
