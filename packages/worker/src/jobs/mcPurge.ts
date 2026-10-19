/**
 * mc.purge: keep the facet change log (facet_changes) small. The triggers
 * only append (migration 0048), so a key that changes often gathers rows; once a
 * day this
 *
 *   1. re-logs, as an upsert, any key whose newest row is a delete older than
 *      90 days yet which has data now (a writer's op can go stale when two
 *      write at once; the feed serves what is there, the log must not lose it),
 *   2. drops every row a newer row of the same key supersedes (facet,
 *      key, library, person, source): the feed serves a key's current data from its
 *      newest row, so the older ones say nothing more,
 *   3. drops delete rows older than 90 days whose key has no data, the time
 *      the feeds promise to keep tombstones (spec §3). A cursor from before
 *      then gets 410 Gone and the linked app takes a fresh snapshot.
 *
 * It also prunes the provider side's OAuth records (pruneOAuth): token
 * families that ended (every token revoked or expired) more than 30 days
 * ago, then registered clients older than 30 days with no token family left
 * in that window and no authorization in flight. The client side's own
 * links (mc_links, mc_pending) are never touched. One audit entry
 * (mc.oauth.prune) says how many went.
 *
 * Writers never wait on this: they only insert. Deletes go in batches so no
 * statement holds locks or bloats WAL for long. Runs daily on the worker that
 * serves facets.refresh (database upkeep).
 *
 * It runs whether or not Music Connections is on (Settings › Modules): the
 * triggers are core transport and keep logging while the module is off, so
 * this housekeeping keeps the log small either way. It touches only
 * facet_changes and the provider's ended OAuth records; the switch guards the network-facing parts (tick, pulls,
 * feeds, OAuth).
 */
import { TOMBSTONE_DAYS } from 'music-connections';
import type { WorkerContext } from '../lib/context.js';

/** The protocol's tombstone window (music-connections › TOMBSTONE_DAYS). */
export const MC_TOMBSTONE_DAYS = TOMBSTONE_DAYS;

/** Days an ended token family, or an unused client, is kept before mc.purge deletes it. */
export const OAUTH_KEEP_DAYS = 30;

export interface McPurgeJobData {
  /** days a tombstone is kept (default 90) */
  keepDays?: number;
  /** days an ended token family or an unused client is kept (default 30) */
  oauthKeepDays?: number;
  /** rows per delete statement (default 5000) */
  batchSize?: number;
}

export async function mcPurgeJob(
  ctx: WorkerContext,
  data: McPurgeJobData = {},
): Promise<{ relogged: number; superseded: number; tombstones: number; families: number; tokens: number; clients: number }> {
  const keepDays = data.keepDays ?? MC_TOMBSTONE_DAYS;
  const batchSize = data.batchSize ?? 5000;

  const relogged = (await ctx.sql`
    insert into facet_changes (facet, key, op, user_id, library_id, source_module, source_ref)
    select m.facet, m.key, 'upsert', m.user_id, m.library_id, m.source_module, m.source_ref
      from facet_changes m
     where m.op = 'delete' and m.changed_at < now() - make_interval(days => ${keepDays})
       and not exists (select 1 from facet_changes n
                        where n.facet = m.facet and n.key = m.key and n.library_id = m.library_id
                          and n.user_id is not distinct from m.user_id
                          and n.source_ref is not distinct from m.source_ref and (n.changed_at, n.id) > (m.changed_at, m.id))
       and facet_present(m.facet, m.library_id, m.user_id, m.key)
    returning 1`).length;

  let superseded = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from facet_changes
       where id in (
         select m.id from facet_changes m
          where exists (select 1 from facet_changes n
                         where n.facet = m.facet and n.key = m.key and n.library_id = m.library_id
                           and n.user_id is not distinct from m.user_id
                          and n.source_ref is not distinct from m.source_ref and (n.changed_at, n.id) > (m.changed_at, m.id))
          limit ${batchSize})
      returning 1`;
    superseded += rows.length;
    if (rows.length < batchSize) break;
  }

  let tombstones = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from facet_changes
       where id in (
         select m.id from facet_changes m
          where m.op = 'delete' and m.changed_at < now() - make_interval(days => ${keepDays})
            and not facet_present(m.facet, m.library_id, m.user_id, m.key)
          limit ${batchSize})
      returning 1`;
    tombstones += rows.length;
    if (rows.length < batchSize) break;
  }

  ctx.logger.info({ relogged, superseded, tombstones, keepDays }, 'mc.purge: facet change log compacted');
  const oauth = await pruneOAuth(ctx, data.oauthKeepDays ?? OAUTH_KEEP_DAYS, batchSize);
  return { relogged, superseded, tombstones, ...oauth };
}

/**
 * When a provider token stopped working: when it was revoked, or when the
 * last thing it could do expired (a rotated token's refresh is spent at
 * rotation; its access token lives on until it expires).
 */
const DEAD_AT = `least(coalesce(t.revoked_at, 'infinity'::timestamptz),
  case when t.rotated_at is not null then greatest(t.access_expires_at, t.rotated_at)
       else greatest(t.access_expires_at, coalesce(t.refresh_expires_at, t.access_expires_at)) end)`;

/**
 * The provider side's OAuth records (mc_oauth_*), in batches of at most
 * `batchSize` (token families, then clients) per delete statement, like the
 * change log above, so no statement holds locks or bloats WAL for long:
 *
 *   1. token families whose every token stopped working more than keepDays
 *      ago (revoked, or expired); a family with one token still usable, or
 *      only recently dead, stays whole (a replayed rotated token must still
 *      find its family), and a family always goes in one statement;
 *   2. registered clients created more than keepDays ago with no token left
 *      that worked within keepDays and no authorization in flight (a
 *      request not yet decided or a code not yet exchanged, still in time);
 *      their expired requests go with them (on delete cascade).
 *
 * Every statement checks its conditions again, so a batch never removes
 * what came back to life since the one before. Never the client side's own
 * links (mc_links, mc_pending).
 */
export async function pruneOAuth(
  ctx: WorkerContext,
  keepDays: number,
  batchSize = 5000,
): Promise<{ families: number; tokens: number; clients: number }> {
  let families = 0;
  let tokens = 0;
  for (;;) {
    const rows = await ctx.sql.unsafe<Array<{ family_id: string }>>(`
      delete from mc_oauth_tokens
       where family_id in (
         select t.family_id from mc_oauth_tokens t
          group by t.family_id
         having max(${DEAD_AT}) < now() - make_interval(days => $1)
          limit $2)
      returning family_id::text`, [keepDays, batchSize]);
    const batch = new Set(rows.map((r) => r.family_id)).size;
    families += batch;
    tokens += rows.length;
    if (batch < batchSize) break;
  }
  let clients = 0;
  for (;;) {
    const n = (await ctx.sql.unsafe(`
      delete from mc_oauth_clients
       where client_id in (
         select c.client_id from mc_oauth_clients c
          where c.created_at < now() - make_interval(days => $1)
            and not exists (select 1 from mc_oauth_tokens t
                             where t.client_id = c.client_id and ${DEAD_AT} >= now() - make_interval(days => $1))
            and not exists (select 1 from mc_oauth_requests r
                             where r.client_id = c.client_id
                               and ((r.decided_at is null and r.expires_at > now())
                                    or (r.code_hash is not null and r.code_used_at is null and r.code_expires_at > now())))
          limit $2)
      returning 1`, [keepDays, batchSize])).length;
    clients += n;
    if (n < batchSize) break;
  }
  const out = { families, tokens, clients };
  if (tokens > 0 || clients > 0) {
    await ctx.sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
             values (null, null, 'mc.oauth.prune', 'mc_client',
                     ${JSON.stringify({ ...out, keep_days: keepDays })}::text::jsonb)`;
  }
  ctx.logger.info({ ...out, keepDays }, 'mc.purge: ended OAuth families and unused clients pruned');
  return out;
}
