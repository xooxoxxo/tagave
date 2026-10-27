import { IDENTIFY_REQUESTED_BY_OWNER } from '@tagave/shared';
import type { WorkerContext } from './context.js';

/** Queues that run identifyAlbumJob. */
export const IDENTIFY_QUEUES = ['identify.album', 'identify.acoustid'] as const;

/**
 * Cancel identify jobs still waiting for albums that no longer exist (merged
 * into another, or retired by regrouping). Running jobs are left alone:
 * identifyAlbumJob notices the album is gone and stops quietly. A cancelled
 * job the owner asked for (Identify now, or pinned to a release) is logged at
 * info: the owner's request ends without a result, so the log says why.
 */
export async function cancelQueuedIdentify(
  ctx: Pick<WorkerContext, 'sql' | 'boss'> & { logger?: Pick<WorkerContext['logger'], 'info'> },
  albumIds: readonly string[],
): Promise<number> {
  if (albumIds.length === 0) return 0;
  const rows = (await ctx.sql`
    select id, name, data->>'localAlbumId' as "albumId",
           (data->>'requestedBy' = ${IDENTIFY_REQUESTED_BY_OWNER}
            or data ? 'pinnedMbid' or data ? 'pinnedReleaseGroup' or data ? 'pinnedDiscogs') as owner
      from pgboss.job
     where name in ${ctx.sql([...IDENTIFY_QUEUES])}
       and state in ('created', 'retry')
       and data->>'localAlbumId' = any(${[...albumIds]}::text[])`) as unknown as Array<{ id: string; name: string; albumId?: string; owner?: boolean }>;
  for (const name of IDENTIFY_QUEUES) {
    const ids = rows.filter((r) => r.name === name).map((r) => r.id);
    if (ids.length > 0) await ctx.boss.cancel(name, ids);
  }
  const owners = rows.filter((r) => r.owner === true);
  if (owners.length > 0) {
    ctx.logger?.info({ jobs: owners.map((r) => ({ id: r.id, queue: r.name, albumId: r.albumId })) },
      'identify: cancelled an identify the owner asked for; its album no longer exists (merged or regrouped)');
  }
  return rows.length;
}
