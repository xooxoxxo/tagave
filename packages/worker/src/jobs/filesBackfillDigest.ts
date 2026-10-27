/**
 * files.backfillDigest (move-safe scanning §3): core_tags_digest for every row
 * parsed before it existed, from the stored tags_raw by the row's handler
 * (its identityDigest), missing rows included:
 * ghosts cannot be re-parsed, and B's Repair pairs them by this digest.
 * Keyset over id so rows that have no core tags (digest stays null) are
 * passed once, not re-read forever. Enqueued once at boot; idempotent.
 *
 * Each batch is one select and one update, each its own statement, so no
 * transaction is held. Safe beside scans: the update only fills a digest that
 * is still null for tags that are still the ones read (same tags_digest), so a
 * parse or tag write in between keeps its own value.
 */
import { fileTypeHandler } from '@tagave/core/files';
import type { WorkerContext } from '../lib/context.js';

export interface FilesBackfillDigestJobData { batch?: number }

export async function filesBackfillDigestJob(ctx: Pick<WorkerContext, 'sql' | 'logger'>, data: FilesBackfillDigestJobData = {}): Promise<{ updated: number }> {
  const batch = Math.max(1, data.batch ?? 1000);
  let after = '00000000-0000-0000-0000-000000000000';
  let updated = 0;
  for (;;) {
    // the where clause is idx_files_digest_backfill's predicate (0052): keep them identical
    const rows = (await ctx.sql`
      select id, handler, tags_raw, tags_digest from files
       where core_tags_digest is null and tags_raw is not null and id > ${after}::uuid
       order by id limit ${batch}`) as unknown as Array<{ id: string; handler: string; tags_raw: unknown; tags_digest: string | null }>;
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    const ids: string[] = [];
    const digests: string[] = [];
    const seenAs: Array<string | null> = [];
    for (const r of rows) {
      const d = fileTypeHandler(r.handler)?.identityDigest(typeof r.tags_raw === 'string' ? JSON.parse(r.tags_raw) : r.tags_raw) ?? null;
      if (d === null) continue;
      ids.push(r.id); digests.push(d); seenAs.push(r.tags_digest);
    }
    if (ids.length > 0) {
      const res = await ctx.sql`
        update files af set core_tags_digest = u.d
          from unnest(${ids}::uuid[], ${digests}::text[], ${seenAs}::text[]) as u(id, d, td)
         where af.id = u.id and af.core_tags_digest is null
           and af.tags_digest is not distinct from u.td`;
      updated += (res as unknown as { count?: number }).count ?? 0;
    }
    if (rows.length < batch) break;
  }
  ctx.logger.info({ updated }, 'files.backfillDigest done');
  return { updated };
}
