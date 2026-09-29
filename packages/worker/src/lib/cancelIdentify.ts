import type { WorkerContext } from './context.js';

/** Queues that run identifyAlbumJob. */
export const IDENTIFY_QUEUES = ['identify.album', 'identify.acoustid'] as const;

/**
 * Cancel identify jobs still waiting for albums that no longer exist (merged
 * into another, or retired by regrouping). Running jobs are left alone:
 * identifyAlbumJob notices the album is gone and stops quietly.
 */
export async function cancelQueuedIdentify(
  ctx: Pick<WorkerContext, 'sql' | 'boss'>,
  albumIds: readonly string[],
): Promise<number> {
  if (albumIds.length === 0) return 0;
  const rows = (await ctx.sql`
    select id, name from pgboss.job
     where name in ${ctx.sql([...IDENTIFY_QUEUES])}
       and state in ('created', 'retry')
       and data->>'localAlbumId' = any(${[...albumIds]}::text[])`) as unknown as Array<{ id: string; name: string }>;
  for (const name of IDENTIFY_QUEUES) {
    const ids = rows.filter((r) => r.name === name).map((r) => r.id);
    if (ids.length > 0) await ctx.boss.cancel(name, ids);
  }
  return rows.length;
}
