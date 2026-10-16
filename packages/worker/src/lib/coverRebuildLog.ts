/**
 * The install-wide limit on cover refetches (cover_rebuild_log, 0046): at
 * most REFETCH_BUDGET_PER_DAY albums a day go back to art.fetch because
 * their original was gone, whichever sweep asks (startup, nightly, after a
 * restore, or one the api requested). Counted in the database, so restarts
 * and several workers share it.
 */
import type { WorkerContext } from './context.js';

export const REFETCH_BUDGET_PER_DAY = 200;
/** Serialises reservations: two sweeps never both spend the same headroom. */
const LOCK_KEY = 7_302_046_001;

/**
 * Reserve up to the remaining daily budget for these albums, in order,
 * skipping albums already sent in the last 24 hours. Returns the albums
 * that may be refetched now; a row per album is logged.
 */
export async function reserveRefetches(
  sql: WorkerContext['sql'],
  albumIds: string[],
  budget: number = REFETCH_BUDGET_PER_DAY,
): Promise<string[]> {
  if (albumIds.length === 0) return [];
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
    await tx`delete from cover_rebuild_log where at < now() - interval '7 days'`;
    const [row] = await tx`select count(*)::int as n from cover_rebuild_log
                            where kind = 'refetch' and at > now() - interval '24 hours'`;
    const left = Math.max(0, budget - Number(row?.['n'] ?? 0));
    // an album sent in the last day is not sent again: a refetch that found
    // nothing must not spend the budget every sweep
    const recent = new Set((await tx`select distinct album_id from cover_rebuild_log
      where kind = 'refetch' and at > now() - interval '24 hours' and album_id = any(${albumIds}::uuid[])`)
      .map((r) => r['album_id'] as string));
    const granted = albumIds.filter((id) => !recent.has(id)).slice(0, left);
    if (granted.length > 0) {
      await tx`insert into cover_rebuild_log (kind, album_id) select 'refetch', unnest(${granted}::uuid[])`;
    }
    return granted;
  }) as Promise<string[]>;
}

/** Give back one album's reservation (its refetch was not queued after all). */
export async function releaseRefetch(sql: WorkerContext['sql'], albumId: string): Promise<void> {
  await sql`delete from cover_rebuild_log where id = (
    select id from cover_rebuild_log where kind = 'refetch' and album_id = ${albumId} order by at desc, id desc limit 1)`;
}
