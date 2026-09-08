import type { WorkerContext } from '../lib/context.js';
import { libraryProviderSettings } from '../lib/providers.js';

export interface FingerprintSweepJobData {
  libraryId?: string;
  /** albums to enqueue per library per run (default 30 every 10 min; ~2 fpcalc/s keeps the NAS civil) */
  limit?: number;
}

/**
 * IDN-5 sweep: every 10 minutes, for each library that opted in and has an
 * AcoustID key, hand the next unidentified albums that were never
 * fingerprinted to fingerprint.album — the ones text search could not help
 * first (no tags, no candidates), weak candidates after.
 */
export async function fingerprintSweepJob(ctx: WorkerContext, data: FingerprintSweepJobData): Promise<void> {
  // A parked provider (bad key, quota) means every lookup would fail: fingerprinting
  // ahead of it only burns NAS reads, so the sweep waits for the circuit to close.
  const [parked] = (await ctx.sql`
    select circuit_open_until, last_error from provider_state
    where provider = 'acoustid' and circuit_open_until > now()`) as unknown as Array<{ circuit_open_until: Date; last_error: string | null }>;
  if (parked) {
    ctx.logger.warn({ until: parked.circuit_open_until, reason: parked.last_error }, 'fingerprint.sweep: AcoustID parked, skipping');
    return;
  }
  const libraries = data.libraryId
    ? [data.libraryId]
    : ((await ctx.sql`select id from libraries`) as unknown as Array<{ id: string }>).map((r) => r.id);
  for (const libraryId of libraries) {
    const settings = await libraryProviderSettings(ctx, libraryId);
    if (!settings.fingerprintingEnabled || !settings.acoustidKey) {
      ctx.logger.debug({ libraryId, enabled: !!settings.fingerprintingEnabled, key: !!settings.acoustidKey }, 'fingerprint.sweep: off');
      continue;
    }
    const rows = (await ctx.sql`
      select id from local_albums
      where library_id = ${libraryId} and state = 'unidentified' and fingerprinted_at is null
      order by case identify_reason when 'no_tags' then 0 when 'no_candidates' then 1 when 'weak_candidates' then 2 else 3 end,
               identify_attempts, created_at
      limit ${data.limit ?? 30}`) as unknown as Array<{ id: string }>;
    let enqueued = 0;
    for (const row of rows) {
      const id = await ctx.boss.send('fingerprint.album', { localAlbumId: row.id }, { singletonKey: `fingerprint:${row.id}` });
      if (id) enqueued++;
    }
    const [left] = (await ctx.sql`
      select count(*)::int as n from local_albums
      where library_id = ${libraryId} and state = 'unidentified' and fingerprinted_at is null`) as unknown as Array<{ n: number }>;
    ctx.logger.info({ libraryId, enqueued, remaining: left?.n ?? 0 }, 'fingerprint.sweep');
  }
}
