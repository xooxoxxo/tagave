import type { WorkerContext } from '../lib/context.js';
import {
  clusterScopeKey, clusterSingletonKey, discTokenOfFolder, filenameDiscPrefixesApply,
  relBasename, relDirname,
} from '../lib/helpers.js';

export interface ClusterRepairDiscsJobData {
  libraryId: string;
  /** Limit the sweep to one scan root; every root of the library by default. */
  scanRootId?: string;
  /**
   * 'scan' (the default) finds the multi-disc layouts and re-clusters them;
   * it then queues itself as 'identify' to pick up the clusters that changed.
   */
  phase?: 'scan' | 'identify';
  /** Database clock at the moment the 'scan' phase started (never the worker's). */
  since?: string;
  /**
   * Directories the 'scan' phase handed to cluster.dir. The identify phase
   * only looks at albums that overlap them; omitted when the sweep was too
   * large to carry (see MAX_DIRS_IN_DATA), which widens it to "everything
   * this library re-clustered since `since`".
   */
  dirPaths?: string[];
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
/** Above this the scope list is dropped from the job data rather than bloating it. */
const MAX_DIRS_IN_DATA = 5_000;

type Layout = 'folder-token' | 'tag-disc' | 'filename-prefix';

/**
 * What the run found and did. pg-boss stores a handler's return value as the
 * job output, so `select output from pgboss.job where name = 'cluster.repairDiscs'`
 * is the operator's report — the whole point of the dryRun pass.
 */
export interface ClusterRepairDiscsResult {
  phase: 'scan' | 'identify';
  dryRun: boolean;
  /** scan: distinct scopes found, before `limit`. identify: scopes carried in. */
  scopes: number;
  /** scan: scopes carrying each layout — one scope can carry several. Zeroed on identify. */
  counts: Record<Layout, number>;
  /** jobs this phase sent: cluster.dir on scan, identify.album on identify. Always 0 on a dry run. */
  enqueued: number;
  /** identify phase: clusters the repair changed / newly queued / raised in place */
  albums?: number;
  sent?: number;
  raised?: number;
}

interface Candidate {
  scanRootId: string;
  /** A real directory to hand cluster.dir; it resolves the scope itself. */
  dirPath: string;
  layouts: Set<Layout>;
}

interface DirRow { scan_root_id: string; dir: string }
interface FileRow { scan_root_id: string; rel_path: string }

/**
 * spec: multi-disc repair. Finds the three layouts that hid a disc number from
 * the clusterer -- a disc token on the album folder ("Album CD2"), a disk.no
 * tag of 2 or more inside a single-disc cluster, and "n-tt" filename prefixes
 * -- re-clusters each of them, then re-identifies the clusters that changed.
 *
 * Nothing schedules this; it is run once by hand after deploying the disc-aware
 * clustering, and is safe to re-run (every enqueue is deduped by scope).
 */
export async function clusterRepairDiscsJob(
  ctx: WorkerContext,
  data: ClusterRepairDiscsJobData,
): Promise<ClusterRepairDiscsResult> {
  if (data.phase === 'identify') return identifyChangedClusters(ctx, data);

  // The DB clock, not this worker's: the identify phase compares `since`
  // against created_at/updated_at, which Postgres wrote. A worker running a
  // second ahead would skip every cluster the repair itself produced.
  // ISO-8601 straight out of Postgres: the driver hands timestamptz back as a
  // Date in some builds and a string in others, and the marker travels through
  // JSON job data before it comes back as ::timestamptz. to_char truncates the
  // sub-millisecond part downwards, which errs on the inclusive side.
  const [clock] = (await ctx.sql`
    select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`) as unknown as Array<{ now: string }>;
  const since = clock?.now ?? new Date().toISOString();

  const rootId = data.scanRootId ?? null;
  const candidates = new Map<string, Candidate>();
  const add = (scanRootId: string, dir: string, layout: Layout) => {
    // dirPath '' is the scan root itself; cluster.dir would then take the
    // whole root as one scope. Never a candidate, in any layout.
    if (dir === '') return;
    const key = scanRootId + '\n' + clusterScopeKey(dir);
    const hit = candidates.get(key);
    if (hit) hit.layouts.add(layout);
    else candidates.set(key, { scanRootId, dirPath: dir, layouts: new Set([layout]) });
  };

  // Layout 1: the album folder itself carries a disc token. Postgres reduces
  // the library to its distinct directories; the token rules stay in JS so the
  // sweep and the clusterer never disagree about what a disc token is.
  //
  // "Vol. n" folders are candidates too, even though they no longer merge:
  // the shipped-then-reverted rule DID merge them, so a series that was folded
  // into one cluster has to be re-clustered to come apart again. clusterScopeKey
  // gives each of them its own key, so each is enqueued on its own.
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
  // disc from one folder. The tag is the only disc signal those albums have,
  // and re-clustering updates the existing row in place — see the identify
  // phase, which is why it cannot filter on created_at alone.
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
  // filenameDiscPrefixesApply decides, with exactly the gate the clusterer
  // applies to the same file set, so the sweep never enqueues a directory the
  // clusterer will then refuse to read as multi-disc.
  const prefixed = (await ctx.sql`
    select af.scan_root_id, af.rel_path
    from audio_files af
    where af.library_id = ${data.libraryId}
      and af.status in ('present', 'error')
      and (${rootId}::uuid is null or af.scan_root_id = ${rootId}::uuid)
      and af.rel_path ~ '/[0-9]{1,2}[-._][0-9]{2}([^0-9]|$)'`) as unknown as FileRow[];
  const byDir = new Map<string, { scanRootId: string; dir: string; names: string[] }>();
  for (const r of prefixed) {
    const dir = relDirname(r.rel_path);
    if (dir === '') continue;
    const key = r.scan_root_id + '\n' + dir;
    const hit = byDir.get(key);
    if (hit) hit.names.push(relBasename(r.rel_path));
    else byDir.set(key, { scanRootId: r.scan_root_id, dir, names: [relBasename(r.rel_path)] });
  }
  for (const g of byDir.values()) {
    if (filenameDiscPrefixesApply(g.names)) add(g.scanRootId, g.dir, 'filename-prefix');
  }

  const counts: Record<Layout, number> = { 'folder-token': 0, 'tag-disc': 0, 'filename-prefix': 0 };
  for (const c of candidates.values()) for (const l of c.layouts) counts[l] += 1;
  const limit = data.limit ?? DEFAULT_LIMIT;
  const picked = [...candidates.values()].slice(0, limit);
  const result: ClusterRepairDiscsResult = {
    phase: 'scan',
    dryRun: data.dryRun === true,
    scopes: candidates.size,
    counts,
    enqueued: 0,
  };
  ctx.logger.info(
    { libraryId: data.libraryId, ...result, wouldEnqueue: picked.length },
    'cluster.repairDiscs scan',
  );
  if (data.dryRun) return result;

  for (const c of picked) {
    await ctx.boss.send(
      'cluster.dir',
      { libraryId: data.libraryId, scanRootId: c.scanRootId, dirPath: c.dirPath },
      { singletonKey: clusterSingletonKey(c.scanRootId, c.dirPath), singletonSeconds: 30 },
    );
  }
  result.enqueued = picked.length;

  // Re-clustering runs on its own queue; come back once it has had time to
  // land and re-identify whatever clusters it touched. The scopes travel with
  // the job so the identify phase can tell them from every other album a
  // concurrent scan happened to touch in the same window.
  const dirPaths = [...new Set(picked.map((c) => c.dirPath))];
  if (dirPaths.length > MAX_DIRS_IN_DATA) {
    ctx.logger.warn(
      { libraryId: data.libraryId, scopes: dirPaths.length },
      'cluster.repairDiscs: too many scopes to carry; identify phase falls back to the time window',
    );
  }
  await ctx.boss.send(
    'cluster.repairDiscs',
    {
      ...data,
      phase: 'identify',
      since,
      ...(dirPaths.length > MAX_DIRS_IN_DATA ? {} : { dirPaths }),
    },
    { startAfter: data.identifyAfterS ?? DEFAULT_IDENTIFY_AFTER_S },
  );
  return result;
}

/**
 * The clusters the repair changed are the local_albums over the scopes it
 * re-clustered that Postgres wrote since the scan phase began. Both timestamps
 * matter: a sibling-folder or filename-prefix repair produces a NEW cluster_key
 * and so a new row (created_at), while a tag-disc repair changes only disc_no
 * on the tracks of the album that was already there (updated_at). Filtering on
 * created_at alone — the shipped bug — silently skipped every layout-2 album,
 * which is the largest group on prod.
 *
 * State is deliberately not filtered: the albums that most need re-identifying
 * are the ones the disc bug already matched to a one-disc release, so they go
 * back through identify with force.
 */
async function identifyChangedClusters(
  ctx: WorkerContext,
  data: ClusterRepairDiscsJobData,
): Promise<ClusterRepairDiscsResult> {
  const empty: ClusterRepairDiscsResult = {
    phase: 'identify',
    dryRun: data.dryRun === true,
    scopes: data.dirPaths?.length ?? 0,
    counts: { 'folder-token': 0, 'tag-disc': 0, 'filename-prefix': 0 },
    enqueued: 0,
    albums: 0,
    sent: 0,
    raised: 0,
  };
  if (!data.since) {
    ctx.logger.warn({ libraryId: data.libraryId }, 'cluster.repairDiscs identify phase without a since marker');
    return empty;
  }
  const scoped = data.dirPaths !== undefined;
  const albums = (await ctx.sql`
    select id from local_albums
    where library_id = ${data.libraryId}
      and (updated_at >= ${data.since}::timestamptz or created_at >= ${data.since}::timestamptz)
      and (${!scoped}::boolean or dir_paths && ${data.dirPaths ?? []}::text[])
    order by updated_at
    limit ${IDENTIFY_CAP}`) as unknown as Array<{ id: string }>;
  if (albums.length === 0) {
    ctx.logger.info({ libraryId: data.libraryId, since: data.since }, 'cluster.repairDiscs identify: no changed clusters');
    return empty;
  }

  // identify.album is 'stately': one job per album. Raise a job that is already
  // waiting to the bulk tier instead of sending a second one that pg-boss drops.
  // 'retry' counts as waiting — a job that failed once is still ahead of us in
  // the queue, and sending over it is the same dropped duplicate.
  const keys = albums.map((a) => `identify:${a.id}`);
  const raised = (data.dryRun
    ? await ctx.sql`
        select singleton_key from pgboss.job
        where name = 'identify.album' and state in ('created', 'retry') and singleton_key = any(${keys}::text[])`
    : await ctx.sql`
        update pgboss.job set priority = greatest(priority, ${IDENTIFY_PRIORITY})
        where name = 'identify.album' and state in ('created', 'retry') and singleton_key = any(${keys}::text[])
        returning singleton_key`) as unknown as Array<{ singleton_key: string }>;
  const already = new Set(raised.map((r) => r.singleton_key));

  let sent = 0;
  if (!data.dryRun) {
    for (const a of albums) {
      if (already.has(`identify:${a.id}`)) continue;
      await ctx.boss.send('identify.album', { localAlbumId: a.id, force: true }, {
        singletonKey: `identify:${a.id}`, priority: IDENTIFY_PRIORITY, retryLimit: 3, retryDelay: 60, retryBackoff: true,
      });
      sent += 1;
    }
  }
  const result: ClusterRepairDiscsResult = {
    ...empty, albums: albums.length, sent, raised: already.size, enqueued: sent,
  };
  ctx.logger.info({ libraryId: data.libraryId, since: data.since, scoped, ...result }, 'cluster.repairDiscs identify');
  return result;
}
