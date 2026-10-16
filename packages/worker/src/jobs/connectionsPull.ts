/**
 * connections.pull (Music Connections spec §4 Consumer side, §5): tagave
 * pulls the feeds of every app a person linked in Settings › Connections.
 *
 *   { }          the 15-minute tick: re-reads stale manifests (daily), then
 *                queues one job per active link that is due;
 *   { linkId }   one link: Sync now, the first pull after linking, a tick's
 *                job, or a retry after a failure (backoff 1, 5, 15, 60 min).
 *
 * A link pulls each capability tagave consumes that the remote provides and
 * the person granted, through the package's pull() (paging, 401 → refresh,
 * 410 → snapshot, 429/503 → Retry-After). The cursor is saved after every
 * page. A refused refresh sets the link to needs_reapproval with its cursors
 * kept; other links keep pulling. Every request goes through @tagave/core/mc
 * (origin pinning, resolved-address checks, no redirects, caps, timeouts).
 *
 * Tokens are opened only in memory and never logged; last_error is always
 * one of a few fixed strings.
 *
 * ── Landing data (Task 4) ──────────────────────────────────────────────────
 * What happens to the items is a CapabilityHandler per capability
 * (`handlers`). pull() has already schema-validated each item (invalid ones
 * are skipped and counted). A handler:
 *
 *   version      bump it when the handler starts landing (or lands
 *                differently): a stored cursor written under another
 *                version is dropped and the capability re-pulls from a full
 *                snapshot, after resnapshot() runs;
 *   apply        lands one page (upserts and deletes, keyed by item.key) and
 *                returns what it applied and skipped. Throwing fails the run
 *                (backoff); the page's cursor is not saved, so it is retried;
 *   resnapshot   the feed restarts from a snapshot (410 Gone, or a new
 *                version): forget or mark what this link landed for the
 *                capability, then reconcile by key as the snapshot arrives.
 *
 * STUB_HANDLERS (version 0) validate and count, and store nothing.
 */
import { randomBytes } from 'node:crypto';
import { FeedTooLarge, ManifestSchema, NeedsReapproval, pull, type Capability, type FeedItem, type Manifest } from 'music-connections';
import {
  FEED_TIMEOUT_MS,
  LinkError,
  availableUngranted,
  endpointsOf,
  expiryFrom,
  fetchRemoteManifest,
  networkReason,
  openTokens,
  pullableCapabilities,
  readJson,
  revokeAtRemote,
  rfetch,
  sealTokens,
  type LinkTokens,
} from '@tagave/core/mc';
import { mcLinkAudit } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';

export interface ConnectionsPullJobData {
  linkId?: string;
}

export interface HandlerContext {
  sql: WorkerContext['sql'];
  logger: WorkerContext['logger'];
  link: { id: string; userId: string; remoteUrl: string; service: string };
  capability: Capability;
}

export interface CapabilityHandler {
  version: number;
  apply(items: FeedItem[], ctx: HandlerContext): Promise<{ applied: number; skipped: number }>;
  resnapshot?(ctx: HandlerContext): Promise<void>;
}

export type PullHandlers = Partial<Record<Capability, CapabilityHandler>>;

/** Validates (pull() already did) and counts; stores nothing. Task 4 replaces these. */
const countOnly: CapabilityHandler = {
  version: 0,
  async apply(items) {
    return { applied: items.length, skipped: 0 };
  },
};
export const STUB_HANDLERS: PullHandlers = {
  'critic-scores': countOnly,
  identity: countOnly,
  'wantlist-suggestions': countOnly,
};

/** Minutes to wait after the Nth consecutive failure (the last one repeats). */
export const BACKOFF_MINUTES = [1, 5, 15, 60] as const;
export const backoffMinutes = (failures: number): number => BACKOFF_MINUTES[Math.min(Math.max(failures, 1), BACKOFF_MINUTES.length) - 1]!;

/** The longest cursor tagave keeps (FeedPageSchema: next ≤ 512). */
export const MAX_CURSOR_LENGTH = 512;
const LEASE = '10 minutes';
const RUN_BUDGET_MS = 5 * 60_000;
const MANIFEST_EVERY = '24 hours';
const SYNC_EVERY = '14 minutes';
const REFRESH_SKEW_MS = 30_000;
const MAX_SLEEP_MS = 30_000;

export type CapCounts = { applied: number; skipped: number };
export type LinkPullResult = { status: 'ok' | 'needs_reapproval' | 'error' | 'busy'; counts: Record<string, CapCounts>; error?: string };

export interface PullOptions {
  handlers?: PullHandlers;
  appSecret?: string | undefined;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
}

class RefreshRejected extends Error {}
class TransientRefresh extends Error {}
/** The link stopped being active mid-run (revoked, address changed): stop, write nothing back. */
class LinkGone extends Error {}
class BudgetSpent extends Error {}

interface LinkRow {
  id: string;
  user_id: string;
  remote_url: string;
  manifest: unknown;
  client_id: string;
  sealed_tokens: string;
  scopes: string[];
  cursors: Record<string, unknown>;
  handler_versions: Record<string, unknown>;
  state: string;
  failures: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, MAX_SLEEP_MS)));

/** A fixed, log-safe message for any failure (no tokens, no remote bodies). */
export function safeMessage(e: unknown): string {
  if (e instanceof LinkError || e instanceof TransientRefresh || e instanceof FeedTooLarge) return e.message;
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'remote timed out';
    if (/^(feed HTTP \d{3}|remote busy \(\d{3}\)|invalid feed page|feed page without next cursor|feed cursor did not advance|410 on snapshot)$/.test(e.message)) return e.message;
    const net = networkReason(e, '');
    if (net) return net;
  }
  return 'sync failed';
}

export async function connectionsPullJob(ctx: WorkerContext, data: ConnectionsPullJobData = {}, opts: PullOptions = {}): Promise<unknown> {
  if (data.linkId) return runLinkPull(ctx, data.linkId, opts);
  return connectionsTick(ctx);
}

/** The 15-minute tick: daily manifest re-reads, then one queued job per due link. */
export async function connectionsTick(ctx: WorkerContext): Promise<{ manifests: number; queued: number }> {
  const stale = await ctx.sql<Array<{ id: string }>>`
    select id from mc_links
     where state = 'active' and (manifest_checked_at is null or manifest_checked_at < now() - ${MANIFEST_EVERY}::interval)
     order by manifest_checked_at nulls first limit 100`;
  for (const l of stale) {
    try {
      await refreshLinkManifest(ctx, l.id);
    } catch {
      ctx.logger.error({ linkId: l.id }, 'connections.pull: manifest re-read crashed');
    }
  }
  const due = await ctx.sql<Array<{ id: string }>>`
    select id from mc_links
     where state = 'active'
       and (next_attempt_at is null or next_attempt_at <= now())
       and (last_attempt_at is null or last_attempt_at < now() - ${SYNC_EVERY}::interval)
       and (pull_lease_until is null or pull_lease_until < now())
     order by last_attempt_at nulls first limit 500`;
  for (const l of due) await ctx.boss.send('connections.pull', { linkId: l.id }, { singletonKey: `connections.pull:${l.id}` });
  if (due.length || stale.length) ctx.logger.info({ queued: due.length, manifests: stale.length }, 'connections.pull: links queued');
  return { manifests: stale.length, queued: due.length };
}

const newOwner = () => randomBytes(16).toString('hex');

async function claimLease(ctx: WorkerContext, linkId: string): Promise<string | null> {
  const owner = newOwner();
  const rows = await ctx.sql`
    update mc_links set pull_lease_until = now() + ${LEASE}::interval, pull_lease_owner = ${owner}
     where id = ${linkId} and state = 'active' and (pull_lease_until is null or pull_lease_until < now())
    returning id`;
  return rows.length > 0 ? owner : null;
}

async function releaseLease(ctx: WorkerContext, linkId: string, owner: string): Promise<void> {
  await ctx.sql`update mc_links set pull_lease_until = null, pull_lease_owner = null where id = ${linkId} and pull_lease_owner = ${owner}`
    .catch(() => ctx.logger.error({ linkId }, 'connections.pull: lease release failed'));
}

/** Pull one link. "busy" when another run holds it; nothing happens to a link that is not active. */
export async function runLinkPull(ctx: WorkerContext, linkId: string, opts: PullOptions = {}): Promise<LinkPullResult> {
  const owner = await claimLease(ctx, linkId);
  if (!owner) {
    const [l] = await ctx.sql<Array<{ state: string }>>`select state from mc_links where id = ${linkId}`;
    if (!l) return { status: 'error', counts: {}, error: 'no such link' };
    if (l.state === 'needs_reapproval') return { status: 'needs_reapproval', counts: {} };
    return { status: l.state === 'active' ? 'busy' : 'error', counts: {} };
  }
  try {
    return await pullLeased(ctx, linkId, owner, opts);
  } finally {
    await releaseLease(ctx, linkId, owner);
  }
}

async function pullLeased(ctx: WorkerContext, linkId: string, owner: string, opts: PullOptions): Promise<LinkPullResult> {
  const sql = ctx.sql;
  const handlers = opts.handlers ?? STUB_HANDLERS;
  const appSecret = opts.appSecret ?? process.env['APP_SECRET'];
  const sleep = opts.sleep ?? realSleep;
  const deadline = Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS);
  const [link] = await sql<LinkRow[]>`
    select id, user_id, remote_url, manifest, client_id, sealed_tokens, scopes, cursors, handler_versions, state, failures
      from mc_links where id = ${linkId}`;
  if (!link || link.state !== 'active') return { status: 'error', counts: {} };
  const counts: Record<string, CapCounts> = {};

  let tok: LinkTokens | null = openTokens(link.sealed_tokens, appSecret);
  // Unreadable (APP_SECRET changed): only a fresh approval fixes it.
  if (!tok) return needsReapproval(ctx, link, counts, 'tokens unreadable');

  const saveCursor = async (cap: string, cursor: string | null, version: number | null): Promise<void> => {
    // The feed schema caps a cursor at 512 characters; pull() hands next on as sent.
    if (cursor !== null && cursor.length > MAX_CURSOR_LENGTH) throw new LinkError('feed cursor too long');
    const rows = await sql`
      update mc_links
         set cursors = ${cursor === null ? sql`cursors - ${cap}::text` : sql`cursors || jsonb_build_object(${cap}::text, ${cursor}::text)`},
             handler_versions = ${version === null ? sql`handler_versions - ${cap}::text` : sql`handler_versions || jsonb_build_object(${cap}::text, ${version}::int)`},
             pull_lease_until = now() + ${LEASE}::interval
       where id = ${link.id} and state = 'active' and pull_lease_owner = ${owner}
      returning id`;
    if (rows.length === 0) throw new LinkGone();
  };

  try {
    const parsed = ManifestSchema.safeParse(link.manifest);
    if (!parsed.success) throw new LinkError('stored manifest invalid');
    const manifest: Manifest = parsed.data;
    const origin = new URL(link.remote_url).origin;
    // Re-pinned on every run: every endpoint on the link's origin, through the allow-list.
    const endpoints = endpointsOf(manifest, origin);

    const refresh = async (): Promise<string> => {
      const t = tok!;
      if (!t.refresh_token) throw new RefreshRejected();
      let res: Response;
      try {
        res = await rfetch(endpoints.token, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: link.client_id, client_secret: t.client_secret }).toString(),
        });
      } catch (e) {
        throw new TransientRefresh(safeMessage(e) === 'sync failed' ? 'token refresh failed' : safeMessage(e));
      }
      if (res.status === 400 || res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        throw new RefreshRejected();
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new TransientRefresh(`token refresh HTTP ${res.status}`);
      }
      const j = (await readJson(res)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof j.access_token !== 'string' || !j.access_token) throw new TransientRefresh('token refresh answer invalid');
      tok = {
        ...t,
        access_token: j.access_token,
        refresh_token: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : t.refresh_token,
        access_expires_at: expiryFrom(j.expires_in),
      };
      // The old refresh token is spent: keep the new pair before using it, only
      // while the link is still active at this address. A revoke or address
      // change that raced this refresh gets the new tokens revoked instead.
      const saved = await sql`update mc_links set sealed_tokens = ${sealTokens(tok, appSecret)}, updated_at = now()
                               where id = ${link.id} and state = 'active' and remote_url = ${link.remote_url} returning id`;
      if (saved.length === 0) {
        await revokeAtRemote({ remoteUrl: link.remote_url, manifest: link.manifest, clientId: link.client_id }, tok);
        throw new LinkGone();
      }
      return tok.access_token;
    };

    // pull() turns any refresh failure into NeedsReapproval; keep the real
    // cause so a network blip during a refresh backs off instead.
    let refreshError: unknown = null;
    const refreshForPull = async () => {
      try {
        return await refresh();
      } catch (e) {
        refreshError = e;
        throw e;
      }
    };
    const exp = Date.parse(tok.access_expires_at);
    if (Number.isFinite(exp) && exp - REFRESH_SKEW_MS < Date.now()) await refresh();

    const cursors = link.cursors ?? {};
    const versions = link.handler_versions ?? {};
    for (const cap of pullableCapabilities(manifest, link.scopes)) {
      const handler = handlers[cap];
      const feedUrl = endpoints.feeds[cap];
      if (!handler || !feedUrl) continue;
      const hctx: HandlerContext = { sql, logger: ctx.logger, capability: cap, link: { id: link.id, userId: link.user_id, remoteUrl: link.remote_url, service: manifest.service } };
      const acc: CapCounts = (counts[cap] = { applied: 0, skipped: 0 });
      let start = typeof cursors[cap] === 'string' && cursors[cap] ? (cursors[cap] as string) : null;
      // A cursor written under another handler version (none recorded: 0, the
      // stubs): start this capability afresh.
      if (start !== null && (typeof versions[cap] === 'number' ? versions[cap] : 0) !== handler.version) {
        await saveCursor(cap, null, null);
        await handler.resnapshot?.(hctx);
        start = null;
      }
      try {
        const r = await pull({
          url: feedUrl,
          capability: cap,
          cursor: start,
          apply: async (items) => {
            const x = await handler.apply(items, hctx);
            acc.applied += x.applied;
            acc.skipped += x.skipped;
          },
          onPage: async (cursor) => { await saveCursor(cap, cursor, handler.version); },
          // The guarded reset first: a link that is no longer active is never cleared.
          onResnapshot: async () => { await saveCursor(cap, null, null); await handler.resnapshot?.(hctx); },
        }, {
          fetch: ((input: string | URL | Request, init?: RequestInit) => {
            if (Date.now() > deadline) throw new BudgetSpent();
            const url = input instanceof Request ? input.url : String(input);
            if (new URL(url).origin !== origin) throw new LinkError('endpoint on another host');
            return rfetch(url, init, { timeoutMs: FEED_TIMEOUT_MS });
          }) as typeof fetch,
          getToken: async () => tok!.access_token,
          refreshToken: refreshForPull,
          sleep,
        });
        acc.skipped += r.skipped;
      } catch (e) {
        if (e instanceof NeedsReapproval && refreshError && !(refreshError instanceof RefreshRejected)) throw refreshError;
        if (e instanceof BudgetSpent) break; // cursors are saved; the next run continues
        throw e;
      }
    }

    await sql`update mc_links set last_sync_at = now(), last_attempt_at = now(), last_error = null, failures = 0, next_attempt_at = null,
                                  last_counts = ${JSON.stringify(counts)}::jsonb, updated_at = now()
               where id = ${link.id} and state = 'active'`;
    ctx.logger.info({ linkId: link.id, counts }, 'connections.pull: link pulled');
    return { status: 'ok', counts };
  } catch (e) {
    if (e instanceof LinkGone) return { status: 'error', counts, error: 'link changed during the pull' };
    if (e instanceof NeedsReapproval || e instanceof RefreshRejected) return needsReapproval(ctx, link, counts, 'token refresh rejected');
    const failures = link.failures + 1;
    const minutes = backoffMinutes(failures);
    const message = safeMessage(e);
    if (message === 'sync failed') ctx.logger.error({ linkId: link.id, error: e instanceof Error ? e.name : 'unknown' }, 'connections.pull: unexpected failure');
    else ctx.logger.warn({ linkId: link.id, reason: message, failures, retryInMinutes: minutes }, 'connections.pull: link failed');
    const rows = await sql`update mc_links set failures = ${failures}, next_attempt_at = now() + make_interval(mins => ${minutes}),
                                               last_attempt_at = now(), last_error = ${message}, last_counts = ${JSON.stringify(counts)}::jsonb, updated_at = now()
                            where id = ${link.id} and state = 'active' returning id`;
    // The retry itself: the 15-minute tick alone could not keep 1 and 5 minutes.
    if (rows.length > 0) {
      await ctx.boss.send('connections.pull', { linkId: link.id }, { singletonKey: `connections.pull:${link.id}`, startAfter: minutes * 60 })
        .catch(() => ctx.logger.warn({ linkId: link.id }, 'connections.pull: retry not queued; the tick picks it up'));
    }
    return { status: 'error', counts, error: message };
  }
}

async function needsReapproval(ctx: WorkerContext, link: LinkRow, counts: Record<string, CapCounts>, reason: string): Promise<LinkPullResult> {
  // Cursors are kept so a re-approved link resumes where it stopped.
  const changed = await ctx.sql`update mc_links set state = 'needs_reapproval', last_error = 'needs re-approval', last_attempt_at = now(),
                                                    last_counts = ${JSON.stringify(counts)}::jsonb, updated_at = now()
                                 where id = ${link.id} and state = 'active' returning id`;
  // Only the run that flipped the state records it.
  if (changed.length > 0) {
    let host = '';
    try { host = new URL(link.remote_url).host; } catch { /* validated at link time */ }
    await mcLinkAudit(ctx.sql, { action: 'mc.consumer.refresh_failed', userId: link.user_id, linkId: link.id, payload: { remote_host: host, reason } });
  }
  ctx.logger.info({ linkId: link.id, reason }, 'connections.pull: link needs re-approval');
  return { status: 'needs_reapproval', counts };
}

/**
 * Re-read one link's manifest (same pinning and checks as linking) and keep
 * it. Scopes never change here: a capability the remote starts offering
 * shows as "available, re-link to grant" until the person re-links. A
 * manifest from a different service, or one that fails, keeps the old one.
 */
export async function refreshLinkManifest(ctx: WorkerContext, linkId: string): Promise<boolean> {
  const [link] = await ctx.sql<Array<{ id: string; user_id: string; remote_url: string; manifest: unknown; scopes: string[] }>>`
    select id, user_id, remote_url, manifest, scopes from mc_links where id = ${linkId}`;
  if (!link) return false;
  const prev = ManifestSchema.safeParse(link.manifest);
  let next: Manifest | null = null;
  try {
    const f = await fetchRemoteManifest(link.remote_url);
    if (f.origin !== link.remote_url) throw new LinkError('manifest origin changed');
    if (prev.success && prev.data.service !== f.manifest.service) throw new LinkError('different service');
    next = f.manifest;
  } catch (e) {
    ctx.logger.info({ linkId, reason: safeMessage(e) }, 'connections.pull: manifest not re-read');
  }
  if (!next) {
    await ctx.sql`update mc_links set manifest_checked_at = now() where id = ${linkId}`;
    return false;
  }
  await ctx.sql`update mc_links set manifest = ${JSON.stringify(next)}::jsonb, manifest_checked_at = now(), updated_at = now() where id = ${linkId}`;
  const before = new Set<string>(prev.success ? availableUngranted(prev.data, link.scopes) : []);
  const added = availableUngranted(next, link.scopes).filter((c) => !before.has(c));
  if (added.length > 0) {
    await mcLinkAudit(ctx.sql, { action: 'mc.consumer.capabilities_available', userId: link.user_id, linkId, payload: { remote_host: new URL(link.remote_url).host, added } });
  }
  return true;
}
