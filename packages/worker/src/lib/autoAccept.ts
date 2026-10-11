/**
 * Review matches › Auto-accept: applies the owner's rules (core
 * evaluateAutoAccept) to needs_review albums. Called by identify.album right
 * after an album lands in review (only when the rules are on) and by the
 * queue.autoaccept job when the owner presses "Accept N now".
 *
 * Idempotent: an album is taken only while it is still needs_review (the
 * state update is the guard), so a re-run or a race with the owner deciding
 * by hand accepts nothing twice. Every decision is an album_matches row whose
 * reason starts with AUTO_ACCEPT_REASON_PREFIX — the audit trail the rules
 * dialog lists.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { albumMatches, localAlbums, releases, fetchAutoAcceptRulesRow, fetchRulesInputs } from '@liner/db';
import { evaluateAutoAccept, rulesFromStored } from '@liner/core';
import { AUTO_ACCEPT_REASON_PREFIX, type AutoAcceptRules } from '@liner/shared';
import type { WorkerContext } from './context.js';
import { notifyQueueChanged } from '../jobs/progress.js';
import { linkAlbumTracks } from './trackLinks.js';

export interface RulesRunResult {
  /** needs_review albums the rules looked at */
  considered: number;
  accepted: number;
  /** album id → reason, for the accepted ones */
  acceptedAlbums: Array<{ albumId: string; releaseId: string; reason: string }>;
}

export async function loadRules(ctx: WorkerContext, libraryId: string): Promise<AutoAcceptRules> {
  return rulesFromStored(await fetchAutoAcceptRulesRow(ctx.db, libraryId));
}

/**
 * Apply the rules to the library's needs_review albums (or only `albumIds`).
 * `requireEnabled`: do nothing unless the master switch is on (new matches);
 * the owner's explicit "Accept N now" runs the saved rules either way.
 */
export async function acceptByRules(
  ctx: WorkerContext,
  libraryId: string,
  opts: { albumIds?: string[]; requireEnabled: boolean },
): Promise<RulesRunResult> {
  const result: RulesRunResult = { considered: 0, accepted: 0, acceptedAlbums: [] };
  const rules = await loadRules(ctx, libraryId);
  if (opts.requireEnabled && !rules.enabled) return result;
  const inputs = await fetchRulesInputs(ctx.db, libraryId, opts.albumIds);
  result.considered = inputs.length;
  for (const album of inputs) {
    const decision = evaluateAutoAccept(rules, album, album.candidates);
    if (!decision.accept) continue;
    const reason = `${AUTO_ACCEPT_REASON_PREFIX}: ${decision.reason}`;
    const took = await acceptCandidate(ctx, {
      libraryId,
      albumId: album.albumId,
      releaseId: decision.candidate.releaseId,
      distance: decision.candidate.distance,
      source: decision.candidate.source || null,
      reason,
    });
    if (!took) continue;
    result.accepted += 1;
    result.acceptedAlbums.push({ albumId: album.albumId, releaseId: decision.candidate.releaseId, reason });
    ctx.logger.info({ libraryId, localAlbumId: album.albumId, reason }, 'auto-accept rules: accepted');
  }
  return result;
}

/**
 * Make a candidate the album's live match, as the system. Returns false when
 * the album is no longer waiting for review (decided meanwhile).
 */
export async function acceptCandidate(ctx: WorkerContext, a: {
  libraryId: string; albumId: string; releaseId: string; distance: number; source: string | null; reason: string;
}): Promise<boolean> {
  const rg = await ctx.db.select({ rgId: releases.releaseGroupId }).from(releases).where(eq(releases.id, a.releaseId)).limit(1);
  const took = await ctx.db.transaction(async (tx) => {
    const now = new Date();
    const moved = await tx.update(localAlbums)
      .set({
        state: 'matched',
        releaseId: a.releaseId,
        releaseGroupId: rg[0]?.rgId ?? null,
        identifyReason: null,
        identifiedAt: now,
        updatedAt: now,
      })
      .where(and(eq(localAlbums.id, a.albumId), eq(localAlbums.state, 'needs_review')))
      .returning({ id: localAlbums.id });
    if (moved.length === 0) return false;
    // §11.5: at most one live match per album.
    await tx.update(albumMatches)
      .set({ status: 'rejected', reason: 'superseded by auto-accept rules' })
      .where(and(eq(albumMatches.localAlbumId, a.albumId), inArray(albumMatches.status, ['auto', 'confirmed'])));
    await tx.insert(albumMatches).values({
      libraryId: a.libraryId,
      localAlbumId: a.albumId,
      releaseId: a.releaseId,
      distance: a.distance.toFixed(4),
      status: 'auto',
      decidedBy: 'system',
      reason: a.reason,
      source: a.source,
    });
    return true;
  });
  if (!took) return false;

  await notifyQueueChanged(ctx, a.libraryId, a.albumId, 'matched');
  // ENR-1 + 0026, as for any other accepted match.
  try {
    await ctx.boss.send('enrich.release', { releaseId: a.releaseId }, { singletonKey: `enrich:${a.releaseId}` });
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message, releaseId: a.releaseId }, 'auto-accept rules: enrich enqueue failed');
  }
  try {
    await linkAlbumTracks(ctx, a.albumId, { releaseId: a.releaseId });
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message, localAlbumId: a.albumId }, 'auto-accept rules: track linking failed');
  }
  return true;
}
