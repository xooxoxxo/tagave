/**
 * Ask worker-files to rebuild a cover thumbnail the api found missing.
 * Backups leave cover_thumbs out (0046), so after a restore every cover is
 * missing until the worker's sweep has run; the api serves a placeholder and
 * calls this. A grid of 200 placeholders re-requested on every page view
 * must not turn into 200 queue writes each time, so requests are deduped
 * here for a while before pg-boss dedupes them again by singleton key.
 */
import type { PgBoss } from 'pg-boss';
import type postgres from 'postgres';

export interface ThumbRebuildDeps {
  getBoss: () => Promise<Pick<PgBoss, 'send'>>;
  /**
   * Claims the install's sweep request: true at most once per
   * SWEEP_REQUEST_EVERY_MS across every api process (claimSweepRequest).
   */
  claimSweep: () => Promise<boolean>;
  now?: () => number;
  log?: (obj: object, msg: string) => void;
}

/** The api asks worker-files for a full sweep at most this often, per install. */
export const SWEEP_REQUEST_EVERY_MS = 30 * 60_000;

/**
 * Record a sweep request in cover_rebuild_log unless one was recorded in
 * the last 30 minutes; true when this call got it. One statement under an
 * advisory lock, so two api processes cannot both win.
 */
export async function claimSweepRequest(sql: postgres.Sql): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7302046002)`;
    // the same week-long pruning as the worker's refetch log
    await tx`delete from cover_rebuild_log where at < now() - interval '7 days'`;
    const rows = await tx`
      insert into cover_rebuild_log (kind)
      select 'sweep'
       where not exists (select 1 from cover_rebuild_log
                          where kind = 'sweep' and at > now() - make_interval(secs => ${SWEEP_REQUEST_EVERY_MS / 1000}))
      returning id`;
    return rows.length > 0;
  })) as boolean;
}

/** How long one image (or the sweep) is not asked for again. */
export const REBUILD_REPEAT_MS = 10 * 60_000;
/** Images remembered; past this the oldest requests are forgotten first. */
export const MAX_REMEMBERED = 100_000;

export type ThumbRebuildRequester = (imageId: string) => Promise<void>;

export function makeThumbRebuildRequester(deps: ThumbRebuildDeps, maxRemembered: number = MAX_REMEMBERED): ThumbRebuildRequester {
  const now = deps.now ?? Date.now;
  const asked = new Map<string, number>();
  // checked here first, so a page of placeholders does not ask the database each time
  let sweepCheckedAt = -Infinity;
  return async (imageId: string) => {
    const t = now();
    const last = asked.get(imageId);
    if (last !== undefined && t - last < REBUILD_REPEAT_MS) return;
    // A Map iterates in insertion order: re-inserting moves an image to the
    // end, so the first keys are the oldest requests.
    asked.delete(imageId);
    while (asked.size >= maxRemembered) asked.delete(asked.keys().next().value!);
    asked.set(imageId, t);
    try {
      const boss = await deps.getBoss();
      await boss.send('art.thumb', { imageId }, { singletonKey: `thumb:${imageId}` });
      // One miss usually means many (a restore): queue the sweep too, at
      // most once per 30 minutes for the whole install.
      if (t - sweepCheckedAt >= REBUILD_REPEAT_MS) {
        sweepCheckedAt = t;
        if (await deps.claimSweep()) await boss.send('art.thumbSweep', {}, { singletonKey: 'art.thumbSweep' });
      }
    } catch (err) {
      asked.delete(imageId);
      deps.log?.({ imageId, err: (err as Error).message }, 'could not queue a cover thumbnail rebuild');
    }
  };
}
