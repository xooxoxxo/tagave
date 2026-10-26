/**
 * Merging a moved file's two rows (move-safe scanning §1, merge rules). The
 * old row's id wins: everything attached to it (tracks, overrides, locks,
 * embedded covers, tag-plan journal) stays attached. One transaction:
 *   1. lock both rows FOR UPDATE (in id order, no deadlock between merges);
 *   2. check the old row is still where the snapshot saw it and still gone;
 *   3. check the fresh row has no local_tracks, cluster_overrides, images or
 *      tag_plan_items (if it has, Task 16's absorb path or skip);
 *   4. copy the fresh row's parse when it has one, delete the fresh row,
 *      re-point the old row (root, path, present, last_seen_at = now()).
 *
 * The FOR UPDATE lock also covers a concurrent cluster.dir or tag plan: their
 * inserts take FOR KEY SHARE on the fresh row, so they either committed before
 * the lock (step 3 sees them and the merge skips) or wait for this merge.
 */
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
  tags_read_at: string | null;
  /** last_seen_at < walkStart, null without a walkStart. The client reads timestamptz as text, so the DB compares. */
  seen_before_walk: boolean | null;
}

/** Columns scan.parse writes; copied from a parsed fresh row so the merge needs no re-parse. */
const PARSE_COLUMNS = [
  'container', 'codec', 'lossless', 'duration_ms', 'sample_rate', 'bit_depth', 'channels', 'bitrate_kbps',
  'has_embedded_art', 'tags_raw', 'tags_digest', 'core_tags_digest', 'tags_read_at', 'parse_error', 'status',
] as const;

export async function mergeFilePair(ctx: Pick<WorkerContext, 'sql'>, req: MergeRequest): Promise<MergeOutcome> {
  const walkStart = req.walkStart ? req.walkStart.toISOString() : null;
  return ctx.sql.begin(async (tx) => {
    const rows = (await tx`
      select id, library_id, scan_root_id, rel_path, status, size_bytes, mtime, inode, tags_read_at,
             last_seen_at < ${walkStart}::timestamptz as seen_before_walk
        from audio_files where id = any(${[req.oldId, req.freshId].sort()}::uuid[]) order by id for update`) as unknown as FileRow[];
    const old = rows.find((r) => r.id === req.oldId);
    const fresh = rows.find((r) => r.id === req.freshId);
    if (!fresh) return { kind: 'skipped', reason: 'fresh_gone' } as const;
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
      return { kind: 'skipped', reason: 'fresh_has_data' } as const; // Task 16 replaces this line
    }

    const parsed = fresh.tags_read_at !== null;
    const reparse = !parsed && (Number(old.size_bytes) !== Number(fresh.size_bytes) || Number(old.mtime) !== Number(fresh.mtime));
    if (parsed) {
      const cols = PARSE_COLUMNS.join(', ');
      await tx.unsafe(`update audio_files o set (${cols}) = (select ${cols} from audio_files f where f.id = $1) where o.id = $2`, [fresh.id, old.id]);
    }
    // Parsed: status came with the parse. Unparsed: present, except an
    // unparseable (error) old row with no re-parse due keeps 'error' (pre-flight F13).
    const status = parsed ? null : old.status === 'error' && !reparse ? 'error' : 'present';
    await tx`delete from audio_files where id = ${fresh.id}`;
    await tx`
      update audio_files set
        scan_root_id = ${fresh.scan_root_id}, rel_path = ${fresh.rel_path},
        status = coalesce(${status}::text, status),
        size_bytes = ${fresh.size_bytes}, mtime = ${fresh.mtime}, inode = coalesce(${fresh.inode}, inode),
        last_seen_at = now(), reconcile_hold_at = null
      where id = ${old.id}`;
    return {
      kind, oldId: old.id, libraryId: old.library_id,
      from: { scanRootId: old.scan_root_id, relPath: old.rel_path },
      to: { scanRootId: fresh.scan_root_id, relPath: fresh.rel_path },
      reparse, removedAlbumIds,
    };
  });
}
