/**
 * Merging a moved file's two rows (move-safe scanning §1, merge rules). The
 * old row's id wins: everything attached to it (tracks, overrides, locks,
 * embedded covers, tag-plan journal) stays attached. One transaction for a
 * pair, or for all the pairs of one fresh album (mergeFilePairs):
 *   1. lock the rows FOR UPDATE (in id order, no deadlock between merges);
 *   2. check each old row is still where the snapshot saw it and still gone;
 *   3. check each fresh row has no local_tracks, cluster_overrides, images or
 *      tag_plan_items; if it has (the destination was clustered first), absorb
 *      the pairs when allowed and untouched (see absorbPairs), else skip;
 *   4. copy the fresh row's parse when it has one, delete the fresh row,
 *      re-point the old row (root, path, present, last_seen_at = now());
 *      track-scope field locks move with it, and changed bytes clear the
 *      old row's audio hash and fingerprint.
 *
 * The FOR UPDATE lock also covers a concurrent cluster.dir or tag plan: their
 * inserts take FOR KEY SHARE on the fresh row, so they either committed before
 * the lock (step 3 sees them and the merge skips) or wait for this merge.
 */
import type postgres from 'postgres';
import { albumKeyLock } from '@tagave/db';
import { IDENTIFY_REQUESTED_BY_OWNER } from '@tagave/shared';
import { IDENTIFY_QUEUES } from './cancelIdentify.js';
import type { WorkerContext } from './context.js';

export interface MergeRequest {
  oldId: string;
  freshId: string;
  oldAt: { scanRootId: string; relPath: string };
  /** Tier 1: the walk's start (an old row seen since is not gone). Tier 2: null, the old row must be missing. */
  walkStart: Date | null;
  allowAbsorb: boolean;
}

export interface MergeDone {
  kind: 'merged' | 'absorbed';
  oldId: string;
  libraryId: string;
  from: { scanRootId: string; relPath: string };
  to: { scanRootId: string; relPath: string };
  reparse: boolean;
  removedAlbumIds: string[];
}

export type MergeOutcome = MergeDone | { kind: 'skipped'; reason: 'old_moved' | 'fresh_gone' | 'fresh_has_data' | 'fresh_touched' };

interface FileRow {
  id: string; library_id: string; scan_root_id: string; rel_path: string; status: string;
  size_bytes: string | null; mtime: string | null; inode: string | null;
  tags_read_at: string | null; parse_error: string | null;
  /** last_seen_at < walkStart, null without a walkStart. The client reads timestamptz as text, so the DB compares. */
  seen_before_walk: boolean | null;
}

/** Columns scan.parse writes; copied from a parsed fresh row so the merge needs no re-parse. */
const PARSE_COLUMNS = [
  'container', 'codec', 'lossless', 'duration_ms', 'sample_rate', 'bit_depth', 'channels', 'bitrate_kbps',
  'has_embedded_art', 'tags_raw', 'tags_digest', 'core_tags_digest', 'tags_read_at', 'parse_error', 'status',
] as const;

/**
 * Owner-set data on the fresh side (spec §1: no confirmed match, locks,
 * overrides, ratings by local id, tag plans; Ruling 12 adds as_is/ignored,
 * owner merges and owner covers; review round 1 adds gap decisions, excluded
 * candidates and owner identify requests; an album the owner marked preferred
 * among duplicates counts too). Album-level checks cover the albums the fresh
 * rows' tracks sit on, except `exceptAlbumId`: the old row's own album, which a
 * same-path move to another root clusters the copy onto (its owner data is the
 * old side's, which wins anyway). Null when untouched. Listens, plays, player
 * events and collection links do not count: they move.
 */
export async function freshTouchedReason(
  tx: postgres.TransactionSql, freshIds: string | readonly string[], exceptAlbumId: string | null = null,
): Promise<string | null> {
  const ids = typeof freshIds === 'string' ? [freshIds] : [...freshIds];
  const [r] = await tx`
    with fa as (select distinct local_album_id as id from local_tracks
                 where audio_file_id = any(${ids}::uuid[]) and local_album_id is not null
                   and local_album_id is distinct from ${exceptAlbumId}::uuid),
         ft as (select id from local_tracks where audio_file_id = any(${ids}::uuid[])),
         lib as (select distinct library_id as id from audio_files where id = any(${ids}::uuid[]))
    select
      case
        when exists (select 1 from local_albums la join fa on fa.id = la.id
                      where la.state in ('as_is', 'ignored') or la.merged_from is not null or coalesce(la.preferred, false)) then 'owner album state'
        when exists (select 1 from album_matches m join fa on fa.id = m.local_album_id where m.decided_by <> 'system') then 'owner match decision'
        when exists (select 1 from match_candidates c join fa on fa.id = c.local_album_id where c.excluded) then 'excluded candidate'
        when exists (select 1 from field_locks fl where (fl.scope = 'album' and fl.scope_id in (select id from fa))
                                                     or (fl.scope = 'track' and fl.scope_id = any(${ids}::uuid[]))) then 'locks'
        when exists (select 1 from cluster_overrides co where co.audio_file_id = any(${ids}::uuid[]) or co.local_album_id in (select id from fa)) then 'cluster override'
        when exists (select 1 from tag_plan_items t where t.audio_file_id = any(${ids}::uuid[])) then 'tag plan'
        when exists (select 1 from user_reviews u join lib on lib.id = u.library_id
                      where u.favorite_track_ids && (select coalesce(array_agg(id), '{}') from ft)) then 'favourite track'
        when exists (select 1 from images i join fa on fa.id = i.local_album_id where i.origin = 'owner') then 'owner cover'
        when exists (select 1 from gaps g join fa on fa.id = g.subject_id
                      where g.subject_type = 'local_album'
                        and (g.accepted_at is not null or g.decided_at is not null or g.note is not null or g.state = 'dismissed')) then 'gap decision'
      end as reason,
      (select coalesce(array_agg(id::text), '{}') from fa) as albums`;
  const reason = (r?.['reason'] as string | null) ?? null;
  if (reason) return reason;
  return (await ownerIdentifyRequested(tx, (r?.['albums'] as string[] | undefined) ?? [])) ? 'owner identify request' : null;
}

/**
 * An identify job the owner asked for (Identify now, or pinned to a release)
 * still waiting or running for one of these albums: the same test the app's
 * identify requests use (MANUAL_JOB). Read under a savepoint: without pg-boss
 * tables (tests that fake or drop pgboss.job) there is no such job.
 */
export async function ownerIdentifyRequested(tx: postgres.TransactionSql, albumIds: readonly string[]): Promise<boolean> {
  if (albumIds.length === 0) return false;
  try {
    return await tx.savepoint(async (sp) => {
      const rows = await sp`
        select 1 from pgboss.job j
         where j.name = any(${[...IDENTIFY_QUEUES]}::text[]) and j.state in ('created', 'retry', 'active')
           and j.data->>'localAlbumId' = any(${[...albumIds]}::text[])
           and (j.data->>'requestedBy' = ${IDENTIFY_REQUESTED_BY_OWNER}
                or j.data ? 'pinnedMbid' or j.data ? 'pinnedReleaseGroup' or j.data ? 'pinnedDiscogs')
         limit 1`;
      return rows.length > 0;
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01' || code === '3F000') return false; // no pgboss.job (or schema)
    throw err;
  }
}

interface AlbumRef { id: string; library_id: string; cluster_key: string }
interface AlbumOf extends AlbumRef { fresh: boolean; old: boolean }

/** Albums the files' tracks sit on; `fresh`/`old` mark which side holds a track there. */
async function albumsOf(tx: postgres.TransactionSql, oldIds: string[], freshIds: string[]): Promise<AlbumOf[]> {
  return (await tx`
    select la.id, la.library_id, la.cluster_key,
           bool_or(lt.audio_file_id = any(${freshIds}::uuid[])) as fresh,
           bool_or(lt.audio_file_id = any(${oldIds}::uuid[])) as old
      from local_tracks lt join local_albums la on la.id = lt.local_album_id
     where lt.audio_file_id = any(${[...oldIds, ...freshIds]}::uuid[])
     group by la.id`) as unknown as AlbumOf[];
}

/**
 * Takes the album-key locks (clusterDir, retireEmptyAlbums and split-by-format
 * hold them while they fill or delete an album) and then the album rows, in a
 * fixed order: keys sorted, rows by id. The same order as cluster.dir (key,
 * album rows, then the files' rows), so the two queue instead of deadlocking.
 */
async function lockAlbums(tx: postgres.TransactionSql, albums: AlbumRef[], held: Set<string>): Promise<void> {
  const todo = albums.filter((a) => !held.has(a.id));
  if (todo.length === 0) return;
  const keys = [...new Set(todo.map((a) => albumKeyLock(a.library_id, a.cluster_key)))].sort();
  for (const k of keys) await tx`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
  await tx`select id from local_albums where id = any(${todo.map((a) => a.id)}::uuid[]) order by id for update`;
  for (const a of todo) held.add(a.id);
}

interface LivePair { req: MergeRequest; old: FileRow; fresh: FileRow; deps: boolean }

export async function mergeFilePair(ctx: Pick<WorkerContext, 'sql'>, req: MergeRequest): Promise<MergeOutcome> {
  return (await mergeFilePairs(ctx, [req]))[0]!;
}

/**
 * Merges the pairs in one transaction; outcomes in request order. Pairs whose
 * fresh rows were clustered (destination clustered first) are absorbed
 * together or not at all: a fresh album is folded into the old one only when
 * every one of its tracks belongs to a fresh row of these pairs and none of
 * them is touched by the owner (review round 1). A fresh album absorbed only
 * in part would keep its cluster key, the next cluster.dir would fill it with
 * the old rows, and the old album would keep its history with no tracks.
 * The requests must share one walkStart (one walk's plan).
 */
export async function mergeFilePairs(ctx: Pick<WorkerContext, 'sql'>, reqs: readonly MergeRequest[]): Promise<MergeOutcome[]> {
  if (reqs.length === 0) return [];
  const walkStartMs = reqs[0]!.walkStart?.getTime() ?? null;
  if (reqs.some((r) => (r.walkStart?.getTime() ?? null) !== walkStartMs)) throw new Error('mergeFilePairs: requests from different walks');
  const walkStart = reqs[0]!.walkStart ? reqs[0]!.walkStart.toISOString() : null;
  const oldIds = reqs.map((r) => r.oldId);
  const freshIds = reqs.map((r) => r.freshId);
  return ctx.sql.begin(async (tx) => {
    // Absorb may delete fresh albums and write to the old one: their locks
    // come first (read unlocked here, checked again under the row locks below).
    const heldAlbums = new Set<string>();
    if (reqs.some((r) => r.allowAbsorb)) {
      const albums = await albumsOf(tx, oldIds, freshIds);
      if (albums.some((a) => a.fresh)) await lockAlbums(tx, albums, heldAlbums);
    }
    const rows = (await tx`
      select id, library_id, scan_root_id, rel_path, status, size_bytes, mtime, inode, tags_read_at, parse_error,
             last_seen_at < ${walkStart}::timestamptz as seen_before_walk
        from audio_files where id = any(${[...new Set([...oldIds, ...freshIds])].sort()}::uuid[]) order by id for update`) as unknown as FileRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const outcomes: Array<MergeOutcome | null> = reqs.map(() => null);
    const live: Array<LivePair & { i: number }> = [];
    reqs.forEach((req, i) => {
      const old = byId.get(req.oldId);
      const fresh = byId.get(req.freshId);
      if (!fresh) { outcomes[i] = { kind: 'skipped', reason: 'fresh_gone' }; return; }
      // A later walk marked the fresh path missing (or it was archived): it is no longer the live copy.
      if (fresh.status !== 'present' && fresh.status !== 'error') { outcomes[i] = { kind: 'skipped', reason: 'fresh_touched' }; return; }
      if (!old || old.scan_root_id !== req.oldAt.scanRootId || old.rel_path !== req.oldAt.relPath) {
        outcomes[i] = { kind: 'skipped', reason: 'old_moved' }; return;
      }
      const gone = old.status === 'missing'
        || (walkStart !== null && (old.status === 'present' || old.status === 'error') && old.seen_before_walk === true);
      if (!gone) { outcomes[i] = { kind: 'skipped', reason: 'old_moved' }; return; }
      live.push({ i, req, old, fresh, deps: false });
    });
    if (live.length === 0) return outcomes as MergeOutcome[];

    const withDeps = new Set((await tx`
      select f.id from unnest(${live.map((p) => p.fresh.id)}::uuid[]) as f(id)
       where exists (select 1 from local_tracks where audio_file_id = f.id)
          or exists (select 1 from cluster_overrides where audio_file_id = f.id)
          or exists (select 1 from images where audio_file_id = f.id)
          or exists (select 1 from tag_plan_items where audio_file_id = f.id)`).map((r) => r['id'] as string));
    for (const p of live) p.deps = withDeps.has(p.fresh.id);

    const absorbing = live.filter((p) => p.deps);
    let removedAlbumIds: string[] = [];
    if (absorbing.length > 0) {
      const allowed = absorbing.filter((p) => p.req.allowAbsorb);
      for (const p of absorbing) if (!p.req.allowAbsorb) outcomes[p.i] = { kind: 'skipped', reason: 'fresh_has_data' };
      // The destination was clustered before the source went missing: fold the
      // fresh rows' tracks and albums into the old ones (spec §1 → §5 Repair merge).
      const absorbed = allowed.length > 0 ? await absorbPairs(tx, allowed, heldAlbums) : null;
      if (absorbed === null) {
        for (const p of allowed) outcomes[p.i] = { kind: 'skipped', reason: 'fresh_touched' };
      } else {
        removedAlbumIds = absorbed;
      }
    }

    let first = true;
    for (const p of live) {
      if (outcomes[p.i]) continue;
      const done = await repoint(tx, p.old, p.fresh);
      const kind: MergeDone['kind'] = p.deps ? 'absorbed' : 'merged';
      // the removed albums are reported once, on the first absorbed pair
      outcomes[p.i] = { ...done, kind, removedAlbumIds: kind === 'absorbed' && first ? removedAlbumIds : [] };
      if (kind === 'absorbed') first = false;
    }
    return outcomes as MergeOutcome[];
  });
}

/** Steps 4: copy the parse, delete the fresh row, re-point the old one. */
async function repoint(tx: postgres.TransactionSql, old: FileRow, fresh: FileRow): Promise<Omit<MergeDone, 'kind' | 'removedAlbumIds'>> {
  // A failed parse is a parse too: its status 'error' and parse_error come over with it.
  const parsed = fresh.tags_read_at !== null || fresh.parse_error !== null;
  const reparse = !parsed && (Number(old.size_bytes) !== Number(fresh.size_bytes) || Number(old.mtime) !== Number(fresh.mtime));
  if (parsed) {
    const cols = PARSE_COLUMNS.join(', ');
    await tx.unsafe(`update audio_files o set (${cols}) = (select ${cols} from audio_files f where f.id = $1) where o.id = $2`, [fresh.id, old.id]);
  }
  // Parsed: status came with the parse. Unparsed: present, except an
  // unparseable (error) old row with no re-parse due keeps 'error' (pre-flight F13).
  const status = parsed ? null : old.status === 'error' && !reparse ? 'error' : 'present';
  // Track-scope locks key on the audio file id without a FK: move the fresh
  // row's locks over, except where the old row already locks that field.
  await tx`
    delete from field_locks f
     where f.scope = 'track' and f.scope_id = ${fresh.id}
       and exists (select 1 from field_locks o where o.scope = 'track' and o.scope_id = ${old.id} and o.field = f.field)`;
  await tx`update field_locks set scope_id = ${old.id} where scope = 'track' and scope_id = ${fresh.id}`;
  await tx`delete from audio_files where id = ${fresh.id}`;
  await tx`
    update audio_files set
      scan_root_id = ${fresh.scan_root_id}, rel_path = ${fresh.rel_path},
      status = coalesce(${status}::text, status),
      size_bytes = ${fresh.size_bytes}, mtime = ${fresh.mtime}, inode = coalesce(${fresh.inode}, inode),
      last_seen_at = now(), reconcile_hold_at = null
    where id = ${old.id}`;
  if (reparse) {
    // The bytes changed: the old audio identity no longer describes this file.
    await tx`
      update audio_files set audio_hash = null, audio_hash_at = null,
        fingerprint = null, fingerprint_duration = null, fingerprinted_at = null, fingerprint_error = null
      where id = ${old.id}`;
  }
  return {
    oldId: old.id, libraryId: old.library_id,
    from: { scanRootId: old.scan_root_id, relPath: old.rel_path },
    to: { scanRootId: fresh.scan_root_id, relPath: fresh.rel_path },
    reparse,
  };
}

/**
 * The Repair-style merge for pairs whose fresh rows were already clustered
 * (spec §1, "destination clustered first"), all or nothing. Old ids win:
 *   - a fresh track with a twin on its old row (same cue start) goes, and its
 *     plays and player events move to the twin; one without a twin is moved
 *     onto the old row (and into the old album), keeping its id and history;
 *   - each fresh album, emptied that way, hands its listens (one per user and
 *     start: a duplicate of the same listen is dropped, its plays follow the
 *     kept one), plays, events, collection links and any cover kind the old
 *     album lacks to the old album, and is removed.
 * The old album is the one album the old rows' tracks sit on. Returns the
 * removed album ids, or null (nothing changed) when the pairs must fall back
 * to possible moves:
 *   - the fresh side holds owner data (freshTouchedReason);
 *   - a fresh album has tracks of files outside these pairs (it would survive
 *     with its key and take the old rows back on the next cluster.dir);
 *   - there is a fresh album but no old album (pre-flight F6: its listens
 *     would have nowhere to go), or the old rows sit on more than one album.
 * Listening history is never deleted: every re-point runs before any delete.
 */
async function absorbPairs(tx: postgres.TransactionSql, pairs: LivePair[], heldAlbums: Set<string>): Promise<string[] | null> {
  const oldIds = pairs.map((p) => p.old.id);
  const freshIds = pairs.map((p) => p.fresh.id);
  // A cluster.dir may have moved the files between albums since the unlocked
  // read; lock what is there now. Loose fresh tracks touch no album row.
  const albums = await albumsOf(tx, oldIds, freshIds);
  if (albums.some((a) => a.fresh)) await lockAlbums(tx, albums, heldAlbums);
  const oldAlbums = albums.filter((a) => a.old);
  if (oldAlbums.length > 1) return null;
  const oldAlbumId = oldAlbums[0]?.id ?? null;
  const freshAlbums = albums.filter((a) => a.fresh && a.id !== oldAlbumId).map((a) => a.id);
  if (freshAlbums.length > 0) {
    if (!oldAlbumId) return null;
    const [outside] = await tx`
      select 1 from local_tracks where local_album_id = any(${freshAlbums}::uuid[]) and not (audio_file_id = any(${freshIds}::uuid[])) limit 1`;
    if (outside) return null;
  }
  if (await freshTouchedReason(tx, freshIds, oldAlbumId)) return null;

  const tracks = (await tx`
    select id, audio_file_id, cue_start_ms, local_album_id from local_tracks where audio_file_id = any(${[...oldIds, ...freshIds]}::uuid[])`) as unknown as
    Array<{ id: string; audio_file_id: string; cue_start_ms: number | null; local_album_id: string | null }>;
  const fresh = new Set(freshAlbums);
  let relink = false;
  for (const p of pairs) {
    const oldTracks = tracks.filter((t) => t.audio_file_id === p.old.id);
    for (const ft of tracks.filter((t) => t.audio_file_id === p.fresh.id)) {
      const twin = oldTracks.find((ot) => ot.cue_start_ms === ft.cue_start_ms);
      if (twin) {
        await tx`update player_plays set local_track_id = ${twin.id} where local_track_id = ${ft.id}`;
        await tx`update player_events set local_track_id = ${twin.id} where local_track_id = ${ft.id}`;
        await tx`delete from local_tracks where id = ${ft.id}`;                 // player_track_map cascades
      } else if (ft.local_album_id && fresh.has(ft.local_album_id)) {
        // No twin: the row moves onto the old file and album; its link was to
        // the fresh album's release, so it starts over (Ruling 11).
        await tx`
          update local_tracks set audio_file_id = ${p.old.id}, local_album_id = ${oldAlbumId},
                 canonical_track_id = null, recording_id = null, match_distance = null, state = 'unmatched'
           where id = ${ft.id}`;
        relink = true;
      } else {
        await tx`update local_tracks set audio_file_id = ${p.old.id} where id = ${ft.id}`;
      }
    }
  }
  if (relink) await tx`update local_albums set tracks_linked_at = null where id = ${oldAlbumId}`;
  let removed: string[] = [];
  if (freshAlbums.length > 0) {
    // One listen per (user, album, start): duplicates of a listen the old
    // album (or another fresh album) already has are dropped, their plays first
    // moved to the kept one.
    const dupes = (await tx`
      select id, keep from (
        select id, first_value(id) over w as keep, row_number() over w as rn
          from player_listens where local_album_id = any(${[oldAlbumId, ...freshAlbums]}::uuid[])
        window w as (partition by user_id, started_at order by (local_album_id = ${oldAlbumId}) desc, tracks_heard desc, id)
      ) d where rn > 1`) as unknown as Array<{ id: string; keep: string }>;
    if (dupes.length > 0) {
      await tx`
        update player_plays p set player_listen_id = d.keep
          from unnest(${dupes.map((d) => d.id)}::uuid[], ${dupes.map((d) => d.keep)}::uuid[]) as d(id, keep)
         where p.player_listen_id = d.id`;
      await tx`delete from player_listens where id = any(${dupes.map((d) => d.id)}::uuid[])`;
    }
    await tx`update player_listens set local_album_id = ${oldAlbumId} where local_album_id = any(${freshAlbums}::uuid[])`;
    await tx`update player_plays set local_album_id = ${oldAlbumId} where local_album_id = any(${freshAlbums}::uuid[])`;
    await tx`update player_events set local_album_id = ${oldAlbumId} where local_album_id = any(${freshAlbums}::uuid[])`;
    await tx`update collection_items set local_album_id = ${oldAlbumId} where local_album_id = any(${freshAlbums}::uuid[])`;
    // One cover per kind: the old album keeps its own; a kind it lacks comes
    // from a fresh album (the rest go with it). A fresh album's sidecar cover
    // may be the very sidecar the old cover is re-pointed to after the merges
    // (Task 13), so keeping both would show the same image twice.
    await tx`
      update images i set local_album_id = ${oldAlbumId},
             entity_id = case when i.entity_type = 'local_album' then ${oldAlbumId}::uuid else i.entity_id end
       where i.id in (select distinct on (kind) id from images where local_album_id = any(${freshAlbums}::uuid[]) order by kind, created_at, id)
         and not exists (select 1 from images o where o.local_album_id = ${oldAlbumId} and o.kind = i.kind)`;
    removed = (await tx`delete from local_albums la where la.id = any(${freshAlbums}::uuid[])
                          and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)
                        returning la.id`).map((r) => r['id'] as string);
  }
  // The old rows are these files now: embedded covers still in use follow them; the rest go.
  for (const p of pairs) {
    await tx`update images set audio_file_id = ${p.old.id} where audio_file_id = ${p.fresh.id} and origin = 'embedded' and local_album_id is not null`;
  }
  await tx`delete from images where audio_file_id = any(${freshIds}::uuid[]) and origin = 'embedded'`;
  return removed;
}
