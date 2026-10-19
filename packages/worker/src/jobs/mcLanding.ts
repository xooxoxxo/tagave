/**
 * Landing what connections.pull brings in (Facets and Connectors design
 * §10, Music Connections spec §3 Identity rules): one CapabilityHandler per
 * capability tagave consumes, each writing only its own module table, keyed
 * by (link, remote key).
 *
 *   critic-scores         → mc_critic_scores (album.critic-scores@1)
 *   identity              → mc_identity, and from there a gap fill, a
 *                           conflict, or a suggestion in the identify queue
 *   wantlist-suggestions  → mc_wantlist_suggestions (the Accept/Dismiss panel)
 *
 * pull() has already checked every item against the package's schema
 * (CAPABILITY_DATA: lengths capped, no prose; unknown fields dropped). Here a
 * review's URL is made absolute against the link's origin and kept only when
 * it is http(s); nothing is ever rendered as HTML.
 *
 * Albums resolve by the release-group MBID, then by the Discogs ids (and
 * the release MBID). An item with no album here is parked (release_group_id
 * null) and attached once the album is matched (attachParked, after each
 * pull and on every tick).
 *
 * Identity rules (both consumers):
 *   - the local release group has no MBID, the item says provenance manual
 *     or embedded with confidence ≥ 0.9, no other release group has that
 *     MBID, and the link's person is an owner (D3): fill the gap
 *     (identity_fills, reverted on unplug);
 *   - another release group already has that MBID: a conflict row (a count
 *     on the link for now);
 *   - anything else, or any disagreement with tagave's MBID: a suggestion,
 *     a match_candidates row with source mc:<link> (its release is fetched
 *     first when tagave does not have it);
 *   - album_matches is never written, and no MBID is ever overwritten.
 */
import type { FeedItem } from 'music-connections';
import { fillAlbumMbid, identifySuggest, identifyWithdraw, mcCandidateSource, revertFills } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';
import type { CapabilityHandler, HandlerContext, PullHandlers } from './connectionsPull.js';
import { mbRelease, persistFetched } from './identifyAlbum.js';

type Sql = WorkerContext['sql'];

/**
 * The landing version: bump it when the handlers land differently. A cursor
 * written under another version (the count-only stubs were 0) is dropped
 * and the capability re-pulls from a full snapshot.
 */
export const LANDING_VERSION = 1;

/** A fill needs at least this confidence, and provenance manual or embedded. */
export const FILL_CONFIDENCE = 0.9;

export interface AlbumRef {
  rg_mbid: string | null;
  release_mbid?: string;
  discogs_master_id?: number;
  discogs_release_id?: number;
  artist: string;
  title: string;
}

export interface LandingDeps {
  /**
   * Fetch a MusicBrainz release tagave does not have yet and keep it (the
   * identify flow's mbRelease + persistFetched). Returns its id, or null.
   */
  fetchRelease?(mbid: string): Promise<string | null>;
}

const lower = (s: string | null | undefined) => (typeof s === 'string' ? s.toLowerCase() : null);
const json = (v: unknown) => JSON.stringify(v);

/** A review URL as tagave keeps it: absolute (a path is the remote's own), http(s) only. */
export function safeUrl(u: string, origin: string): string | null {
  try {
    const url = new URL(u, origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ── Album resolution ───────────────────────────────────────────────────────

interface Rg { id: string; mbid: string | null }

async function rgByMbid(sql: Sql, mbid: string | null): Promise<Rg | null> {
  if (!mbid) return null;
  const [r] = await sql<Rg[]>`select id::text as id, mbid from release_groups where lower(mbid) = ${mbid.toLowerCase()} limit 1`;
  return r ?? null;
}

/** By the Discogs master, the Discogs release, then the release MBID. */
async function rgByOtherIds(sql: Sql, a: AlbumRef): Promise<Rg | null> {
  const master = a.discogs_master_id ?? null;
  const release = a.discogs_release_id ?? null;
  const releaseMbid = lower(a.release_mbid);
  if (master === null && release === null && releaseMbid === null) return null;
  const [r] = await sql<Rg[]>`
    select id, mbid from (
      select rg.id::text as id, rg.mbid, 1 as rank from release_groups rg where ${master}::int is not null and rg.discogs_master_id = ${master}::int
      union all
      select rg.id::text, rg.mbid, 2 from release_groups rg where ${release}::int is not null and rg.discogs_release_id = ${release}::int
      union all
      select rg.id::text, rg.mbid, 3 from releases r join release_groups rg on rg.id = r.release_group_id
       where ${release}::int is not null and r.discogs_release_id = ${release}::int
      union all
      select rg.id::text, rg.mbid, 4 from releases r join release_groups rg on rg.id = r.release_group_id
       where ${releaseMbid}::text is not null and lower(r.mbid) = ${releaseMbid}::text
    ) x order by rank limit 1`;
  return r ?? null;
}

/** Critic scores and suggestions: the MBID first, then the Discogs ids. */
export async function resolveAlbum(sql: Sql, a: AlbumRef): Promise<string | null> {
  return (await rgByMbid(sql, a.rg_mbid))?.id ?? (await rgByOtherIds(sql, a))?.id ?? null;
}

function splitAlbum(item: FeedItem): { album: AlbumRef; data: Record<string, unknown> } {
  const { album, ...data } = item.data as { album: AlbumRef } & Record<string, unknown>;
  return { album, data };
}

// ── critic-scores ──────────────────────────────────────────────────────────

/** The item's data as kept: review URLs absolute and http(s), reviews without one dropped. */
export function criticData(data: Record<string, unknown>, origin: string): Record<string, unknown> {
  const reviews = Array.isArray(data['reviews']) ? (data['reviews'] as Array<Record<string, unknown>>) : [];
  return {
    ...data,
    reviews: reviews.flatMap((r) => {
      const url = typeof r['url'] === 'string' ? safeUrl(r['url'], origin) : null;
      return url ? [{ ...r, url }] : [];
    }),
  };
}

export const criticScoresHandler: CapabilityHandler = {
  version: LANDING_VERSION,
  async apply(items, h) {
    const origin = new URL(h.link.remoteUrl).origin;
    for (const item of items) {
      if (item.op === 'delete') {
        // only this link's row for this key: another link's, and the reviews module's, stay
        await h.sql`delete from mc_critic_scores where link_id = ${h.link.id} and key = ${item.key}`;
        continue;
      }
      const { album, data } = splitAlbum(item);
      const rg = await resolveAlbum(h.sql, album);
      await h.sql`
        insert into mc_critic_scores (link_id, user_id, key, release_group_id, album, data, remote_updated_at, updated_at)
        values (${h.link.id}, ${h.link.userId}, ${item.key}, ${rg}, ${json(album)}::text::jsonb, ${json(criticData(data, origin))}::text::jsonb,
                ${item.updated_at}::text::timestamptz, now())
        on conflict (link_id, key) do update
          set release_group_id = coalesce(excluded.release_group_id, mc_critic_scores.release_group_id),
              album = excluded.album, data = excluded.data, remote_updated_at = excluded.remote_updated_at, updated_at = now(), last_tried_at = null`;
    }
    return { applied: items.length, skipped: 0 };
  },
  async sweep(h, since) {
    return (await h.sql`delete from mc_critic_scores where link_id = ${h.link.id} and updated_at < ${since}::text::timestamptz returning id`).length;
  },
};

// ── wantlist-suggestions ───────────────────────────────────────────────────

export const wantlistHandler: CapabilityHandler = {
  version: LANDING_VERSION,
  async apply(items, h) {
    for (const item of items) {
      if (item.op === 'delete') {
        // a decided suggestion is the person's: only an undecided one goes
        await h.sql`delete from mc_wantlist_suggestions where link_id = ${h.link.id} and key = ${item.key} and decision is null`;
        continue;
      }
      const { album, data } = splitAlbum(item);
      const rg = await resolveAlbum(h.sql, album);
      await h.sql`
        insert into mc_wantlist_suggestions (link_id, user_id, key, release_group_id, album, data, remote_updated_at, updated_at)
        values (${h.link.id}, ${h.link.userId}, ${item.key}, ${rg}, ${json(album)}::text::jsonb, ${json(data)}::text::jsonb,
                ${item.updated_at}::text::timestamptz, now())
        on conflict (link_id, key) do update
          set release_group_id = coalesce(excluded.release_group_id, mc_wantlist_suggestions.release_group_id),
              album = excluded.album, data = excluded.data, remote_updated_at = excluded.remote_updated_at, updated_at = now(), last_tried_at = null`;
    }
    return { applied: items.length, skipped: 0 };
  },
  async sweep(h, since) {
    return (await h.sql`delete from mc_wantlist_suggestions where link_id = ${h.link.id} and decision is null
                         and updated_at < ${since}::text::timestamptz returning id`).length;
  },
};

// ── identity ───────────────────────────────────────────────────────────────

interface IdentityData { local_key: string; provenance: 'manual' | 'embedded' | 'auto'; confidence: number }
interface IdentityRow { id: string; link_id: string; user_id: string; key: string; album: AlbumRef; data: IdentityData; state: string }
export type IdentityState = 'parked' | 'agrees' | 'filled' | 'conflict' | 'suggested' | 'awaiting_release' | 'unresolved';

const strong = (d: IdentityData) => (d.provenance === 'manual' || d.provenance === 'embedded') && d.confidence >= FILL_CONFIDENCE;

async function isOwner(sql: Sql, userId: string): Promise<boolean> {
  const [u] = await sql<Array<{ role: string }>>`select role from users where id = ${userId} and disabled_at is null and removed_at is null`;
  return u?.role === 'owner';
}

/** Withdraw what a link's identity item did: its undecided candidates, and its fill unless a person confirmed it. */
async function retractIdentity(sql: Sql, linkId: string, key: string, actor: string | null): Promise<void> {
  const [row] = await sql<Array<{ release_group_id: string | null; state: string }>>`
    select release_group_id::text as release_group_id, state from mc_identity where link_id = ${linkId} and key = ${key}`;
  if (!row) return;
  await identifyWithdraw(sql, { exact: mcCandidateSource(linkId) }, key);
  if (row.state === 'filled' && row.release_group_id) {
    await revertFills(sql, { module: 'mc', sourceRef: linkId, entityId: row.release_group_id }, actor);
  }
}

/**
 * Suggest the item's release for the albums of `rgId`, through the identify
 * queue's own command (identify.suggest, source mc:<link>). The release must
 * be local (match_candidates.release_id); otherwise the row waits for it
 * (fetchAwaiting fetches it outside any transaction, then decides again).
 */
async function suggest(sql: Sql, row: IdentityRow, rgId: string, service: string): Promise<IdentityState> {
  const releaseMbid = lower(row.album.release_mbid);
  if (!releaseMbid) return 'unresolved';
  const albums = await sql<Array<{ id: string }>>`select id::text as id from local_albums where release_group_id = ${rgId}`;
  if (albums.length === 0) return 'unresolved';
  const [rel] = await sql<Array<{ id: string }>>`select id::text as id from releases where lower(mbid) = ${releaseMbid} limit 1`;
  if (!rel) return 'awaiting_release';
  for (const a of albums) {
    await identifySuggest(sql, {
      localAlbumId: a.id,
      releaseId: rel.id,
      distance: 1 - row.data.confidence,
      breakdown: { mc: { service, provenance: row.data.provenance, confidence: row.data.confidence, rg_mbid: row.album.rg_mbid } },
      source: mcCandidateSource(row.link_id),
      key: row.key,
    });
  }
  return 'suggested';
}

/** Decide one identity item (the rules in the header) and record its state. */
export async function evaluateIdentity(sql: Sql, row: IdentityRow, service: string): Promise<IdentityState> {
  const claim = lower(row.album.rg_mbid);
  const byMbid = await rgByMbid(sql, claim);
  const byOther = await rgByOtherIds(sql, row.album);
  const target = byOther ?? byMbid;
  let state: IdentityState;
  if (!target) state = 'parked';
  else if (!claim || lower(target.mbid) === claim) state = 'agrees';
  else if (target.mbid === null) {
    if (byMbid && byMbid.id !== target.id) state = 'conflict';
    else if (strong(row.data) && (await isOwner(sql, row.user_id))) {
      const r = await fillAlbumMbid(sql, target.id, claim, { module: 'mc', sourceRef: row.link_id, actorUserId: row.user_id });
      state = r === 'filled' ? 'filled' : r === 'in_use' ? 'conflict' : r === 'not_empty' ? 'unresolved' : 'parked';
    } else state = await suggest(sql, row, target.id, service);
  } else {
    // tagave has another MBID: never overwritten, only suggested
    state = await suggest(sql, row, target.id, service);
  }
  await sql`update mc_identity set state = ${state}, release_group_id = ${target?.id ?? null}, updated_at = now(), last_tried_at = now() where id = ${row.id}`;
  return state;
}

export function identityHandler(deps: LandingDeps = {}): CapabilityHandler {
  return {
    version: LANDING_VERSION,
    async apply(items, h) {
      for (const item of items) {
        if (item.op === 'delete') {
          await retractIdentity(h.sql, h.link.id, item.key, h.link.userId);
          await h.sql`delete from mc_identity where link_id = ${h.link.id} and key = ${item.key}`;
          continue;
        }
        const { album, data } = splitAlbum(item);
        // the same fact again (a snapshot resends everything): nothing to redo
        const same = await h.sql`
          update mc_identity set remote_updated_at = ${item.updated_at}::text::timestamptz, updated_at = now()
           where link_id = ${h.link.id} and key = ${item.key} and album = ${json(album)}::text::jsonb and data = ${json(data)}::text::jsonb
             and state not in ('parked', 'awaiting_release')
          returning id`;
        if (same.length > 0) continue;
        await retractIdentity(h.sql, h.link.id, item.key, h.link.userId);
        const [row] = await h.sql<IdentityRow[]>`
          insert into mc_identity (link_id, user_id, key, album, data, state, remote_updated_at, updated_at)
          values (${h.link.id}, ${h.link.userId}, ${item.key}, ${json(album)}::text::jsonb, ${json(data)}::text::jsonb, 'parked',
                  ${item.updated_at}::text::timestamptz, now())
          on conflict (link_id, key) do update
            set album = excluded.album, data = excluded.data, state = 'parked', remote_updated_at = excluded.remote_updated_at, updated_at = now()
          returning id::text as id, link_id::text as link_id, user_id::text as user_id, key, album, data, state`;
        await evaluateIdentity(h.sql, parseRow(row!), h.link.service);
      }
      return { applied: items.length, skipped: 0 };
    },
    async sweep(h, since) {
      const stale = await h.sql<Array<{ key: string }>>`
        select key from mc_identity where link_id = ${h.link.id} and updated_at < ${since}::text::timestamptz`;
      for (const s of stale) await retractIdentity(h.sql, h.link.id, s.key, h.link.userId);
      return (await h.sql`delete from mc_identity where link_id = ${h.link.id} and updated_at < ${since}::text::timestamptz returning id`).length;
    },
    async after(h) {
      // releases a suggestion waits for: fetched a few at a time
      await fetchAwaiting(h, deps, 5);
    },
  };
}

/** postgres.js may hand jsonb back as text (makeDb's parsers): parse it. */
function parseRow(r: IdentityRow): IdentityRow {
  const p = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  return { ...r, album: p<AlbumRef>(r.album), data: p<IdentityData>(r.data) };
}

/**
 * Releases suggestions wait for: each is fetched outside any transaction
 * (a MusicBrainz call can take seconds), then the item is decided again in
 * the link's transaction (h.inLinkTx), so a revoke that came meanwhile wins.
 */
async function fetchAwaiting(h: HandlerContext, deps: LandingDeps, limit: number): Promise<number> {
  if (!deps.fetchRelease) return 0;
  const rows = await h.sql<IdentityRow[]>`
    select id::text as id, link_id::text as link_id, user_id::text as user_id, key, album, data, state
      from mc_identity where state = 'awaiting_release' and link_id = ${h.link.id}
     order by last_tried_at nulls first, id limit ${limit}`;
  let done = 0;
  for (const r of rows) {
    const row = parseRow(r);
    const mbid = lower(row.album.release_mbid);
    try {
      if (mbid) await deps.fetchRelease(mbid);
    } catch (e) {
      h.logger.warn({ linkId: row.link_id, error: e instanceof Error ? e.name : 'unknown' }, 'connections.pull: a suggested release could not be fetched');
    }
    const state = await inLink(h, (tx) => evaluateIdentity(tx, row, h.link.service));
    if (state && state !== 'awaiting_release') done++;
  }
  return done;
}

const inLink = <T>(h: HandlerContext, fn: (sql: Sql) => Promise<T>): Promise<T | null> => (h.inLinkTx ? h.inLinkTx(fn) : fn(h.sql));

// ── Parked items (D4) ──────────────────────────────────────────────────────

/** A link keeps at most this many parked rows per table; beyond it the oldest go (counted on the link). */
export const MAX_PARKED_PER_LINK = 5000;
/** Parked rows tried per table and run, the longest untried first. */
const ATTACH_BATCH = 500;

/**
 * Run `fn` in a transaction holding the link's row (for share), only while
 * the link is active: a revoke (for update on the same row) waits for it,
 * and once a revoke has committed nothing more lands. Null when the link is
 * not active.
 */
export async function lockedForLink<T>(sql: Sql, linkId: string, fn: (tx: Sql) => Promise<T>): Promise<T | null> {
  return sql.begin(async (tx) => {
    const [l] = await tx`select id from mc_links where id = ${linkId} and state = 'active' for share`;
    if (!l) return null;
    return fn(tx as unknown as Sql);
  }) as Promise<T | null>;
}

/**
 * Attach parked rows whose album tagave now has (matched since, or fetched
 * by an identify run), and decide parked identity items afresh. Each try is
 * stamped (last_tried_at) and the longest-untried rows go first, so rows that
 * keep failing never hold the others back. Runs after each link's pull (in
 * that link's transaction) and on every tick (per link, under its lock).
 */
export async function attachParked(sql: Sql, opts: { linkId?: string; h?: HandlerContext; batch?: number; logger?: HandlerContext['logger'] } = {}): Promise<number> {
  const links = opts.linkId
    ? [opts.linkId]
    : (await sql<Array<{ link_id: string }>>`
        select distinct link_id::text as link_id from (
          select link_id from mc_critic_scores where release_group_id is null
          union select link_id from mc_wantlist_suggestions where release_group_id is null
          union select link_id from mc_identity where state = 'parked') p`).map((r) => r.link_id);
  let attached = 0;
  for (const linkId of links) {
    const run = (tx: Sql) => attachForLink(tx, linkId, opts.batch ?? ATTACH_BATCH);
    // Inside a pull the caller's transaction is the link's; its failure is the pull's.
    if (opts.h) {
      attached += (await inLink(opts.h, run)) ?? 0;
      continue;
    }
    // On the tick one link failing must not stop the rest.
    try {
      attached += (await lockedForLink(sql, linkId, run)) ?? 0;
    } catch (e) {
      opts.logger?.error({ linkId, error: e instanceof Error ? e.name : 'unknown' }, 'connections.pull: attaching a link\'s parked items failed');
      await sql`update mc_links set last_error = 'attaching parked items failed', updated_at = now() where id = ${linkId}`
        .catch(() => opts.logger?.error({ linkId }, 'connections.pull: could not record the attach failure'));
    }
  }
  return attached;
}

async function attachForLink(sql: Sql, linkId: string, batch: number): Promise<number> {
  let attached = 0;
  for (const table of ['mc_critic_scores', 'mc_wantlist_suggestions'] as const) {
    const parked = await sql<Array<{ id: string; album: unknown }>>`
      select id::text as id, album from ${sql(table)}
       where release_group_id is null and link_id = ${linkId}
       order by last_tried_at nulls first, id limit ${batch}`;
    for (const p of parked) {
      const album = (typeof p.album === 'string' ? JSON.parse(p.album) : p.album) as AlbumRef;
      const rg = await resolveAlbum(sql, album);
      await sql`update ${sql(table)} set release_group_id = coalesce(release_group_id, ${rg}::uuid), last_tried_at = now() where id = ${p.id}`;
      if (rg) attached++;
    }
  }
  const [svc] = await sql<Array<{ service: string | null }>>`select manifest->>'service' as service from mc_links where id = ${linkId}`;
  const idents = await sql<IdentityRow[]>`
    select id::text as id, link_id::text as link_id, user_id::text as user_id, key, album, data, state
      from mc_identity where state = 'parked' and link_id = ${linkId}
     order by last_tried_at nulls first, id limit ${batch}`;
  for (const r of idents) {
    const row = parseRow(r);
    if (!(await resolveAlbum(sql, row.album))) {
      await sql`update mc_identity set last_tried_at = now() where id = ${row.id}`;
      continue;
    }
    if ((await evaluateIdentity(sql, row, svc?.service ?? '')) !== 'parked') attached++;
  }
  return attached;
}

/**
 * Keep a link's parked rows within MAX_PARKED_PER_LINK per table: the oldest
 * (by when they last arrived) go, and mc_links.parked_dropped counts them.
 * Decided suggestions are the person's and never count or go.
 */
export async function capParked(sql: Sql, linkId: string, max = MAX_PARKED_PER_LINK): Promise<number> {
  let dropped = 0;
  for (const [table, parked] of [
    ['mc_critic_scores', sql`release_group_id is null`],
    ['mc_wantlist_suggestions', sql`release_group_id is null and decision is null`],
    ['mc_identity', sql`state = 'parked'`],
  ] as const) {
    const rows = await sql`
      delete from ${sql(table)} where id in (
        select id from ${sql(table)} where link_id = ${linkId} and ${parked}
         order by updated_at desc, id desc offset ${max})
      returning id`;
    dropped += rows.length;
  }
  if (dropped > 0) await sql`update mc_links set parked_dropped = parked_dropped + ${dropped} where id = ${linkId}`;
  return dropped;
}

/**
 * The identify flow's fetch: the release from MusicBrainz (cached, paced),
 * kept with persistFetched, with the providers of the install's first
 * library (the one links read).
 */
export function defaultLandingDeps(ctx: WorkerContext): LandingDeps {
  return {
    async fetchRelease(mbid) {
      const [lib] = await ctx.sql<Array<{ id: string }>>`select id from libraries order by created_at, id limit 1`;
      if (!lib) return null;
      const p = getProviders(await libraryProviderSettings(ctx, lib.id));
      const r = await mbRelease(ctx, p, mbid);
      return (await persistFetched(ctx, r)).releaseId;
    },
  };
}

/** The handlers connections.pull lands with. */
export function landingHandlers(deps: LandingDeps = {}): PullHandlers {
  return {
    'critic-scores': criticScoresHandler,
    identity: identityHandler(deps),
    'wantlist-suggestions': wantlistHandler,
  };
}
