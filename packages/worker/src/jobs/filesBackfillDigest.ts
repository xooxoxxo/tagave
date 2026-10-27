/**
 * files.backfillDigest (move-safe scanning §3): core_tags_digest for every row
 * parsed before it existed, from the stored tags_raw, missing rows included:
 * ghosts cannot be re-parsed, and B's Repair pairs them by this digest.
 * Keyset over id so rows that have no core tags (digest stays null) are
 * passed once, not re-read forever. Enqueued once at boot; idempotent.
 *
 * Each batch is one select and one update, each its own statement, so no
 * transaction is held. Safe beside scans: the update only fills a digest that
 * is still null for tags that are still the ones read (same tags_digest), so a
 * parse or tag write in between keeps its own value.
 */
import type { WorkerContext } from '../lib/context.js';
import { coreTagsDigest } from '../lib/helpers.js';

export interface FilesBackfillDigestJobData { batch?: number }

export async function filesBackfillDigestJob(ctx: Pick<WorkerContext, 'sql' | 'logger'>, data: FilesBackfillDigestJobData = {}): Promise<{ updated: number }> {
  const batch = Math.max(1, data.batch ?? 1000);
  let after = '00000000-0000-0000-0000-000000000000';
  let updated = 0;
  for (;;) {
    const rows = (await ctx.sql`
      select id, tags_raw, tags_digest from audio_files
       where core_tags_digest is null and tags_raw is not null and id > ${after}::uuid
       order by id limit ${batch}`) as unknown as Array<{ id: string; tags_raw: unknown; tags_digest: string | null }>;
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    const ids: string[] = [];
    const digests: string[] = [];
    const seenAs: Array<string | null> = [];
    for (const r of rows) {
      const d = coreTagsDigest(typeof r.tags_raw === 'string' ? JSON.parse(r.tags_raw) : r.tags_raw);
      if (d === null) continue;
      ids.push(r.id); digests.push(d); seenAs.push(r.tags_digest);
    }
    if (ids.length > 0) {
      const res = await ctx.sql`
        update audio_files af set core_tags_digest = u.d
          from unnest(${ids}::uuid[], ${digests}::text[], ${seenAs}::text[]) as u(id, d, td)
         where af.id = u.id and af.core_tags_digest is null
           and af.tags_digest is not distinct from u.td`;
      updated += (res as unknown as { count?: number }).count ?? ids.length;
    }
    if (rows.length < batch) break;
  }
  ctx.logger.info({ updated }, 'files.backfillDigest done');
  return { updated };
}
