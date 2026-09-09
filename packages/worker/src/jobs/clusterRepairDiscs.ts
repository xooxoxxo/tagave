import type { WorkerContext } from '../lib/context.js';
import { discDirNumber, discTokenOfFolder, filenameDiscPrefix, normKey, relBasename, relDirname } from '../lib/helpers.js';

export interface ClusterRepairDiscsJobData {
  libraryId: string;
  /** Limit the sweep to one scan root; every root of the library by default. */
  scanRootId?: string;
  /**
   * 'scan' (the default) finds the multi-disc layouts and re-clusters them;
   * it then queues itself as 'identify' to pick up the clusters that changed.
   */
  phase?: 'scan' | 'identify';
  /** ISO timestamp the 'scan' phase started; clusters created after it are new. */
  since?: string;
  /** Seconds to wait for the re-clusters to land before the identify phase. */
  identifyAfterS?: number;
  /** Safety cap on how many directories one run re-clusters. */
  limit?: number;
  /** Report what would be enqueued without enqueueing anything. */
  dryRun?: boolean;
}

/** Bulk/triage tier, the same one acoustid.lookup uses to re-identify an album. */
const IDENTIFY_PRIORITY = 50;
const DEFAULT_IDENTIFY_AFTER_S = 600;
const DEFAULT_LIMIT = 20_000;
const IDENTIFY_CAP = 5_000;

type Layout = 'folder-token' | 'tag-disc' | 'filename-prefix';

interface Candidate {
  scanRootId: string;
  /** A real directory to hand cluster.dir; it resolves the scope itself. */
  dirPath: string;
  layouts: Set<Layout>;
}

interface DirRow { scan_root_id: string; dir: string }
interface FileRow { scan_root_id: string; rel_path: string }

/**
 * One key per cluster the re-clustering will produce, so sibling folders of the
 * same album ("... CD1", "... CD2") are enqueued once. clusterDirJob resolves
 * the real scope from whichever sibling it is handed, so any member works.
 */
function scopeKeyOf(dir: string): string {
  const base = relBasename(dir);
  if (discDirNumber(base) !== null) return relDirname(dir);
  const token = discTokenOfFolder(base);
  if (token) return relDirname(dir) + '\n' + normKey(token.title);
  return dir;
}

/**
 * spec: multi-disc repair. Finds the three layouts that hid a disc number from
 * the clusterer -- a disc token on the album folder ("Album CD2"), a disk.no
 * tag of 2 or more inside a single-disc cluster, and "n-tt" filename prefixes
 * -- re-clusters each of them, then re-identifies the clusters that changed.
 *
 * Nothing schedules this; it is run once by hand after deploying the disc-aware
 * clustering, and is safe to re-run (every enqueue is deduped by scope).
 */
export async function clusterRepairDiscsJob(ctx: WorkerContext, data: ClusterRepairDiscsJobData): Promise<void> {
  if (data.phase === 'identify') return identifyChangedClusters(ctx, data);

  const since = new Date().toISOString();
  const rootId = data.scanRootId ?? null;
  const candidates = new Map<string, Candidate>();
  const add = (scanRootId: string, dir: string, layout: Layout) => {
    const key = scanRootId + '\n' + scopeKeyOf(dir);
    const hit = candidates.get(key);
    if (hit) hit.layouts.add(layout);
    else candidates.set(key, { scanRootId, dirPath: dir, layouts: new Set([layout]) });
  };

  // Layout 1: the album folder itself carries a disc token. Postgres reduces
  // the library to its distinct directories; the token rules stay in JS so the
  // sweep and the clusterer never disagree about what a disc token is.
  const dirs = (await ctx.sql`
    select distinct af.scan_root_id,
           case when strpos(af.rel_path, '/') = 0 then ''
                else regexp_replace(af.rel_path, '/[^/]*$', '') end as dir
    from audio_files af
    where af.library_id = ${data.libraryId}
      and af.status in ('present', 'error')
      and (${rootId}::uuid is null or af.scan_root_id = ${rootId}::uuid)`) as unknown as DirRow[];
  for (const r of dirs) {
    if (r.dir !== '' && discTokenOfFolder(relBasename(r.dir))) add(r.scan_root_id, r.dir, 'folder-token');
  }

  // Layout 2: disk.no >= 2 in the tags of a cluster that thinks it holds one
  // disc from one folder. The tag is the only disc signal those albums have.
  const tagged = (await ctx.sql`
    select distinct af.scan_root_id,
           case when strpos(af.rel_path, '/') = 0 then ''
                else regexp_replace(af.rel_path, '/[^/]*$', '') end as dir
    from local_albums la
    join local_tracks lt on lt.local_album_id = la.id
    join audio_files af on af.id = lt.audio_file_id
    where la.library_id = ${data.libraryId}
      and la.disc_count = 1
      and array_length(la.dir_paths, 1) = 1
      and af.status in ('present', 'error')
      and (${rootId}::uuid is null or af.scan_root_id = ${rootId}::uuid)
      and case when af.tags_raw->'common'->'disk'->>'no' ~ '^[0-9]+$'
               then (af.tags_raw->'common'->'disk'->>'no')::int >= 2
               else false end`) as unknown as DirRow[];
  for (const r of tagged) add(r.scan_root_id, r.dir, 'tag-disc');

  // Layout 3: "n-tt" filename prefixes. The SQL regex only narrows the rows;
  // filenameDiscPrefix decides, and a directory qualifies only when two or
  // more distinct disc numbers appear in it (a lone "10-01" box set does not).
  const prefixed = (await ctx.sql`
    select af.scan_root_id, af.rel_path
    from audio_files af
    where af.library_id = ${data.libraryId}
      and af.status in ('present', 'error')
      and (${rootId}::uuid is null or af.scan_root_id = ${rootId}::uuid)
      and af.rel_path ~ '/[0-9]{1,2}[-._][0-9]{2}([^0-9]|$)'`) as unknown as FileRow[];
  const byDir = new Map<string, { scanRootId: string; dir: string; discs: Set<number> }>();
  for (const r of prefixed) {
    const p = filenameDiscPrefix(relBasename(r.rel_path));
    if (!p) continue;
    const dir = relDirname(r.rel_path);
    const key = r.scan_root_id + '\n' + dir;
    const hit = byDir.get(key);
    if (hit) hit.discs.add(p.disc);
    else byDir.set(key, { scanRootId: r.scan_root_id, dir, discs: new Set([p.disc]) });
  }
  for (const g of byDir.values()) {
    if (g.discs.size >= 2) add(g.scanRootId, g.dir, 'filename-prefix');
  }

  const counts: Record<Layout, number> = { 'folder-token': 0, 'tag-disc': 0, 'filename-prefix': 0 };
  for (const c of candidates.values()) for (const l of c.layouts) counts[l] += 1;
  const limit = data.limit ?? DEFAULT_LIMIT;
  const picked = [...candidates.values()].slice(0, limit);
  ctx.logger.info(
    { libraryId: data.libraryId, scopes: candidates.size, enqueueing: picked.length, counts, dryRun: data.dryRun === true },
    'cluster.repairDiscs scan',
  );
  if (data.dryRun) return;

  for (const c of picked) {
    await ctx.boss.send(
      'cluster.dir',
      { libraryId: data.libraryId, scanRootId: c.scanRootId, dirPath: c.dirPath },
      { singletonKey: `cluster:${c.scanRootId}:${c.dirPath}`, singletonSeconds: 30 },
    );
  }

  // Re-clustering runs on its own queue; come back once it has had time to
  // land and re-identify whatever clusters it created.
  await ctx.boss.send(
    'cluster.repairDiscs',
    { ...data, phase: 'identify', since },
    { startAfter: data.identifyAfterS ?? DEFAULT_IDENTIFY_AFTER_S },
  );
}

/**
 * Every cluster the repair created is a new cluster_key, so a new row: the
 * clusters that changed are exactly the local_albums inserted since the scan
 * phase started. They go back through identify at the bulk tier.
 */
async function identifyChangedClusters(ctx: WorkerContext, data: ClusterRepairDiscsJobData): Promise<void> {
  if (!data.since) {
    ctx.logger.warn({ libraryId: data.libraryId }, 'cluster.repairDiscs identify phase without a since marker');
    return;
  }
  const albums = (await ctx.sql`
    select id from local_albums
    where library_id = ${data.libraryId}
      and created_at >= ${data.since}::timestamptz
      and state in ('pending', 'unidentified')
    order by created_at
    limit ${IDENTIFY_CAP}`) as unknown as Array<{ id: string }>;
  if (albums.length === 0) {
    ctx.logger.info({ libraryId: data.libraryId, since: data.since }, 'cluster.repairDiscs identify: no new clusters');
    return;
  }

  // identify.album is 'stately': one job per album. Raise a job that is already
  // waiting to the bulk tier instead of sending a second one that pg-boss drops.
  const keys = albums.map((a) => `identify:${a.id}`);
  const raised = (await ctx.sql`
    update pgboss.job set priority = greatest(priority, ${IDENTIFY_PRIORITY})
    where name = 'identify.album' and state = 'created' and singleton_key = any(${keys}::text[])
    returning singleton_key`) as unknown as Array<{ singleton_key: string }>;
  const already = new Set(raised.map((r) => r.singleton_key));

  let sent = 0;
  for (const a of albums) {
    if (already.has(`identify:${a.id}`)) continue;
    await ctx.boss.send('identify.album', { localAlbumId: a.id, force: true }, {
      singletonKey: `identify:${a.id}`, priority: IDENTIFY_PRIORITY, retryLimit: 3, retryDelay: 60, retryBackoff: true,
    });
    sent += 1;
  }
  ctx.logger.info(
    { libraryId: data.libraryId, since: data.since, newClusters: albums.length, sent, raised: already.size },
    'cluster.repairDiscs identify',
  );
}
