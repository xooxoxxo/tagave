/**
 * Merging a moved file's two rows (move-safe scanning §1, merge rules). The
 * old row's id wins: everything attached to it (tracks, overrides, locks,
 * embedded covers, tag-plan journal) stays attached. One transaction:
 *   1. lock both rows FOR UPDATE (in id order, no deadlock between merges);
 *   2. check the old row is still where the snapshot saw it and still gone;
 *   3. check the fresh row has no local_tracks, cluster_overrides, images or
 *      tag_plan_items; if it has (the destination was clustered first), absorb
 *      it when allowed and untouched (see absorbFresh), else skip;
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
 * owner merges and owner covers; an album the owner marked preferred among
 * duplicates counts too). Null when the fresh side is untouched. Listens,
 * plays, player events and collection links do not count: they move.
 */
export async function freshTouchedReason(tx: postgres.TransactionSql, freshId: string): Promise<string | null> {
  const [r] = await tx`
    with fa as (select distinct local_album_id as id from local_tracks where audio_file_id = ${freshId} and local_album_id is not null),
         ft as (select id from local_tracks where audio_file_id = ${freshId})
    select
      case
        when exists (select 1 from local_albums la join fa on fa.id = la.id
                      where la.state in ('as_is', 'ignored') or la.merged_from is not null or coalesce(la.preferred, false)) then 'owner album state'
        when exists (select 1 from album_matches m join fa on fa.id = m.local_album_id where m.decided_by <> 'system') then 'owner match decision'
        when exists (select 1 from field_locks fl where (fl.scope = 'album' and fl.scope_id in (select id from fa)) or (fl.scope = 'track' and fl.scope_id = ${freshId})) then 'locks'
        when exists (select 1 from cluster_overrides co where co.audio_file_id = ${freshId} or co.local_album_id in (select id from fa)) then 'cluster override'
        when exists (select 1 from tag_plan_items t where t.audio_file_id = ${freshId}) then 'tag plan'
        when exists (select 1 from user_reviews u where u.favorite_track_ids && (select coalesce(array_agg(id), '{}') from ft)) then 'favourite track'
        when exists (select 1 from images i join fa on fa.id = i.local_album_id where i.origin = 'owner') then 'owner cover'
      end as reason`;
  return (r?.['reason'] as string | null) ?? null;
}

interface AlbumRef { id: string; library_id: string; cluster_key: string }

/** Albums the two files' tracks sit on; `fresh` marks those holding a fresh-row track. */
async function albumsOf(tx: postgres.TransactionSql, oldId: string, freshId: string): Promise<Array<AlbumRef & { fresh: boolean }>> {
  return (await tx`
    select la.id, la.library_id, la.cluster_key, bool_or(lt.audio_file_id = ${freshId}::uuid) as fresh
      from local_tracks lt join local_albums la on la.id = lt.local_album_id
     where lt.audio_file_id = any(${[oldId, freshId]}::uuid[])
     group by la.id`) as unknown as Array<AlbumRef & { fresh: boolean }>;
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

export async function mergeFilePair(ctx: Pick<WorkerContext, 'sql'>, req: MergeRequest): Promise<MergeOutcome> {
  const walkStart = req.walkStart ? req.walkStart.toISOString() : null;
  return ctx.sql.begin(async (tx) => {
    // Absorb may delete the fresh album and write to the old one: their locks
    // come first (read unlocked here, checked again under the row locks below).
    const heldAlbums = new Set<string>();
    if (req.allowAbsorb) {
      const albums = await albumsOf(tx, req.oldId, req.freshId);
      if (albums.some((a) => a.fresh)) await lockAlbums(tx, albums, heldAlbums);
    }
    const rows = (await tx`
      select id, library_id, scan_root_id, rel_path, status, size_bytes, mtime, inode, tags_read_at, parse_error,
             last_seen_at < ${walkStart}::timestamptz as seen_before_walk
        from audio_files where id = any(${[req.oldId, req.freshId].sort()}::uuid[]) order by id for update`) as unknown as FileRow[];
    const old = rows.find((r) => r.id === req.oldId);
    const fresh = rows.find((r) => r.id === req.freshId);
    if (!fresh) return { kind: 'skipped', reason: 'fresh_gone' } as const;
    // A later walk marked the fresh path missing (or it was archived): it is no longer the live copy.
    if (fresh.status !== 'present' && fresh.status !== 'error') return { kind: 'skipped', reason: 'fresh_touched' } as const;
    if (!old || old.scan_root_id !== req.oldAt.scanRootId || old.rel_path !== req.oldAt.relPath) {
      return { kind: 'skipped', reason: 'old_moved' } as const;
    }
    const gone = old.status === 'missing'
      || (walkStart !== null && (old.status === 'present' || old.status === 'error') && old.seen_before_walk === true);
    if (!gone) return { kind: 'skipped', reason: 'old_moved' } as const;

    const [deps] = (await tx`
      select exists (select 1 from local_tracks where audio_file_id = ${fresh.id}) as tracks,
             exists (select 1 from cluster_overrides where audio_file_id = ${fresh.id}) as overrides,
             exists (select 1 from images where audio_file_id = ${fresh.id}) as images,
             exists (select 1 from tag_plan_items where audio_file_id = ${fresh.id}) as plans`) as unknown as Array<Record<string, boolean>>;
    let kind: MergeDone['kind'] = 'merged';
    let removedAlbumIds: string[] = [];
    if (deps!['tracks'] || deps!['overrides'] || deps!['images'] || deps!['plans']) {
      if (!req.allowAbsorb) return { kind: 'skipped', reason: 'fresh_has_data' } as const;
      // The destination was clustered before the source went missing: fold the
      // fresh row's track rows and albums into the old ones (spec §1 → §5 Repair merge).
      const absorbed = await absorbFresh(tx, old.id, fresh.id, heldAlbums);
      if (absorbed === null) return { kind: 'skipped', reason: 'fresh_touched' } as const;
      kind = 'absorbed';
      removedAlbumIds = absorbed;
    }

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
      kind, oldId: old.id, libraryId: old.library_id,
      from: { scanRootId: old.scan_root_id, relPath: old.rel_path },
      to: { scanRootId: fresh.scan_root_id, relPath: fresh.rel_path },
      reparse, removedAlbumIds,
    };
  });
}

/**
 * The Repair-style merge for one pair whose fresh row was already clustered
 * (spec §1, "destination clustered first"). Old ids win: the fresh row's
 * tracks go, their plays and player events move to the old row's twin track
 * (same cue start), and a fresh album left without tracks is removed after
 * its listens, plays, events and collection links move to the old album and
 * the old album takes any cover kind it lacks. Returns the removed album ids,
 * or null (nothing changed) when the pair must fall back to a possible move:
 *   - the fresh side holds owner data (freshTouchedReason);
 *   - the old row has no album while the fresh one has (pre-flight F6: its
 *     listens would cascade away with it);
 *   - a listen of the fresh album would collide with the same listen on the old one.
 * Listening history is never deleted: every re-point runs before any delete.
 */
async function absorbFresh(tx: postgres.TransactionSql, oldId: string, freshId: string, heldAlbums: Set<string>): Promise<string[] | null> {
  // A cluster.dir may have moved the files between albums since the unlocked
  // read. Only a fresh album is deleted or folded into the old one; loose
  // fresh tracks touch no album row.
  const albums = await albumsOf(tx, oldId, freshId);
  if (albums.some((a) => a.fresh)) await lockAlbums(tx, albums, heldAlbums);
  if (await freshTouchedReason(tx, freshId)) return null;
  const oldTracks = await tx`select id, cue_start_ms, local_album_id from local_tracks where audio_file_id = ${oldId}`;
  const freshTracks = await tx`select id, cue_start_ms, local_album_id from local_tracks where audio_file_id = ${freshId}`;
  const oldAlbumId = (oldTracks.find((t) => t['local_album_id'])?.['local_album_id'] as string | undefined) ?? null;
  const freshAlbums = [...new Set(freshTracks.map((t) => t['local_album_id'] as string | null).filter((a): a is string => !!a && a !== oldAlbumId))];
  // Fresh albums this pair empties (their other files' tracks keep the rest alive).
  const emptied = freshAlbums.length === 0 ? [] : ((await tx`
    select a.id from unnest(${freshAlbums}::uuid[]) as a(id)
     where not exists (select 1 from local_tracks lt where lt.local_album_id = a.id and lt.audio_file_id <> ${freshId})`) as unknown as Array<{ id: string }>).map((r) => r.id);
  if (freshAlbums.length > 0 && !oldAlbumId) return null;
  if (emptied.length > 0) {
    const [clash] = await tx`
      select 1 from player_listens f
        join player_listens o on o.user_id = f.user_id and o.started_at = f.started_at and o.local_album_id = ${oldAlbumId}
       where f.local_album_id = any(${emptied}::uuid[]) limit 1`;
    if (clash) return null;
  }

  for (const ft of freshTracks) {
    const twin = oldTracks.find((ot) => (ot['cue_start_ms'] ?? null) === (ft['cue_start_ms'] ?? null));
    await tx`update player_plays set local_track_id = ${twin?.['id'] ?? null} where local_track_id = ${ft['id']}`;
    await tx`update player_events set local_track_id = ${twin?.['id'] ?? null} where local_track_id = ${ft['id']}`;
  }
  await tx`delete from local_tracks where audio_file_id = ${freshId}`;                  // player_track_map cascades
  for (const a of emptied) {
    await tx`update player_listens set local_album_id = ${oldAlbumId} where local_album_id = ${a}`;
    await tx`update player_plays set local_album_id = ${oldAlbumId} where local_album_id = ${a}`;
    await tx`update player_events set local_album_id = ${oldAlbumId} where local_album_id = ${a}`;
    await tx`update collection_items set local_album_id = ${oldAlbumId} where local_album_id = ${a}`;
    // One cover per kind: the old album keeps its own; a kind it lacks comes
    // from the fresh album (the rest go with it). The fresh album's sidecar
    // cover may be the very sidecar the old cover is re-pointed to after the
    // merges (Task 13), so keeping both would show the same image twice.
    await tx`
      update images i set local_album_id = ${oldAlbumId},
             entity_id = case when i.entity_type = 'local_album' then ${oldAlbumId}::uuid else i.entity_id end
       where i.id in (select distinct on (kind) id from images where local_album_id = ${a} order by kind, created_at, id)
         and not exists (select 1 from images o where o.local_album_id = ${oldAlbumId} and o.kind = i.kind)`;
    await tx`delete from local_albums where id = ${a}`;
  }
  // The old row is this file now: embedded covers still in use follow it; the rest go.
  await tx`update images set audio_file_id = ${oldId} where audio_file_id = ${freshId} and origin = 'embedded' and local_album_id is not null`;
  await tx`delete from images where audio_file_id = ${freshId} and origin = 'embedded'`;
  return emptied;
}
