import { and, eq, inArray } from 'drizzle-orm';
import { albumMatches, localAlbums, matchCandidates, releases } from '@liner/db';
import { chipCounts, pickByChipRule, MATCHING_THRESHOLDS } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';

export interface QueueAutoAcceptJobData {
  libraryId: string;
}

/**
 * Applies the owner's chip rule (see core/matching/chipRule.ts) to albums
 * already parked in needs_review: no red components, ≥3 greens → accept the
 * candidate with the fewest yellows. New identifications apply the same rule
 * inline in identifyAlbum; this sweep clears the backlog and re-runs are
 * idempotent (accepted albums leave needs_review).
 */
export async function queueAutoAcceptJob(ctx: WorkerContext, data: QueueAutoAcceptJobData): Promise<void> {
  const albums = await ctx.db
    .select({ id: localAlbums.id })
    .from(localAlbums)
    .where(and(eq(localAlbums.libraryId, data.libraryId), eq(localAlbums.state, 'needs_review')));

  let accepted = 0;
  for (const a of albums) {
    const cands = await ctx.db
      .select()
      .from(matchCandidates)
      .where(and(eq(matchCandidates.localAlbumId, a.id), eq(matchCandidates.excluded, false)));
    const inBand = cands
      .map((c) => ({ ...c, dist: Number(c.distance) }))
      .filter((c) => c.dist <= MATCHING_THRESHOLDS.medium);
    const pick = pickByChipRule(
      inBand.map((c) => ({ breakdown: c.breakdown as Record<string, unknown>, distance: c.dist })),
    );
    if (pick < 0) continue;
    const chosen = inBand[pick]!;
    const cc = chipCounts(chosen.breakdown as Record<string, unknown>);

    await ctx.sql`
      update album_matches set status = 'rejected', reason = 'superseded by chip-rule auto-accept'
      where local_album_id = ${a.id} and status in ('auto', 'confirmed')`;
    await ctx.db.insert(albumMatches).values({
      libraryId: data.libraryId,
      localAlbumId: a.id,
      releaseId: chosen.releaseId,
      distance: chosen.dist.toFixed(4),
      status: 'auto',
      decidedBy: 'system',
      reason: `chip-rule auto-accept (queue sweep): ${cc.greens} green, ${cc.yellows} yellow, 0 red (distance ${chosen.dist.toFixed(4)})`,
    });
    const rgRow = await ctx.db
      .select({ rgId: releases.releaseGroupId })
      .from(releases)
      .where(eq(releases.id, chosen.releaseId))
      .limit(1);
    await ctx.db.update(localAlbums)
      .set({
        state: 'matched',
        releaseId: chosen.releaseId,
        releaseGroupId: rgRow[0]?.rgId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(localAlbums.id, a.id));
    accepted += 1;
  }

  await reportProgress(ctx, null, {
    libraryId: data.libraryId,
    type: 'queue.autoaccept',
    state: 'completed',
    message: `${accepted}/${albums.length} needs_review albums auto-accepted by chip rule`,
  });
  ctx.logger.info({ libraryId: data.libraryId, accepted, reviewed: albums.length }, 'chip-rule sweep done');
}
