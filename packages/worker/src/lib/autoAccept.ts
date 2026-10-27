/**
 * Review matches › Auto-accept: applies the owner's rules (core
 * evaluateAutoAccept) to needs_review albums. Called by identify.album right
 * after an album lands in review (only when the rules are on), one album at a
 * time, and by the queue.autoaccept job when the owner presses "Accept N now"
 * or "Run again". That run is one accept batch, so the owner can undo it as a
 * whole.
 *
 * Idempotent: an album is taken only while it is still needs_review (the
 * accept locks the album row and checks its state), so a re-run or a race
 * with the owner deciding by hand accepts nothing twice. Every decision is an album_matches row whose
 * reason starts with AUTO_ACCEPT_REASON_PREFIX — the audit trail the rules
 * dialog lists.
 */
import { createHash } from 'node:crypto';
import { acceptInTx, createBatch, fetchAutoAcceptRulesRow, fetchRulesInputs } from '@tagave/db';
import { evaluateAutoAccept, rulesFromStored, stableJson } from '@tagave/core';
import { AUTO_ACCEPT_REASON_PREFIX, type AutoAcceptRules } from '@tagave/shared';
import type { WorkerContext } from './context.js';
import { notifyQueueChanged } from '../jobs/progress.js';
import { runAcceptBatch } from '../jobs/deciderAccept.js';
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
 * The version a rules batch is stamped with: a short hash of the rules that
 * decide. The master switch is left out, since it only says when the rules
 * run, not what they take.
 */
export function rulesVersion(rules: AutoAcceptRules): string {
  const { enabled: _on, ...decisive } = rules;
  return `rules@${createHash('sha256').update(stableJson(decisive)).digest('hex').slice(0, 8)}`;
}

/**
 * Apply the rules to the library's needs_review albums (or only `albumIds`).
 * `requireEnabled`: do nothing unless the master switch is on (new matches);
 * the owner's explicit "Accept N now" runs the saved rules either way.
 * `viaBatch`: accept everything the rules take as one batch (decider
 * 'rules'), started by `startedByUserId`, which can be undone as a whole; no
 * batch is made when the rules take nothing. Without it each album is
 * accepted on its own, as the identify-time hook does.
 */
export async function acceptByRules(
  ctx: WorkerContext,
  libraryId: string,
  opts: { albumIds?: string[]; requireEnabled: boolean; viaBatch?: boolean; startedByUserId?: string | null },
): Promise<RulesRunResult & { batchId: string | null }> {
  const result: RulesRunResult & { batchId: string | null } = { considered: 0, accepted: 0, acceptedAlbums: [], batchId: null };
  const rules = await loadRules(ctx, libraryId);
  if (opts.requireEnabled && !rules.enabled) return result;
  const inputs = await fetchRulesInputs(ctx.db, libraryId, opts.albumIds);
  result.considered = inputs.length;
  const picks = inputs.flatMap((album) => {
    const d = evaluateAutoAccept(rules, album, album.candidates);
    return d.accept ? [{ album, d, reason: `${AUTO_ACCEPT_REASON_PREFIX}: ${d.reason}` }] : [];
  });

  if (opts.viaBatch) {
    if (picks.length === 0) return result;
    // pinned to the identify run the rules looked at: an album identified
    // again before its turn is skipped rather than accepted on stale facts
    const lastIdentify = await ctx.sql<Array<{ id: string; at: string | Date | null }>>`
      select id, last_identify_at as at from local_albums where id = any(${picks.map((p) => p.album.albumId)}::uuid[])`;
    const at = new Map(lastIdentify.map((r) => [r.id, r.at == null ? null : new Date(r.at).toISOString()]));
    const batchId = await createBatch(ctx.sql, {
      libraryId, deciderId: 'rules', deciderVersion: rulesVersion(rules), decidedKind: 'rule',
      startedByUserId: opts.startedByUserId ?? null,
      items: picks.map(({ album, d, reason }) => ({
        albumId: album.albumId, releaseId: d.candidate.releaseId, distance: d.candidate.distance,
        source: d.candidate.source || null, probability: null, evidenceHash: null,
        expectLastIdentifyAt: at.get(album.albumId) ?? null, reason,
      })),
    });
    result.batchId = batchId;
    const run = await runAcceptBatch(ctx, batchId);
    result.accepted = run.accepted;
    const taken = await ctx.sql<Array<{ local_album_id: string; release_id: string; reason: string }>>`
      select local_album_id, release_id, reason from decider_batch_items
       where batch_id = ${batchId} and status = 'accepted' order by position`;
    result.acceptedAlbums = taken.map((t) => ({ albumId: t.local_album_id, releaseId: t.release_id, reason: t.reason }));
    ctx.logger.info({ libraryId, batchId, accepted: run.accepted, skipped: run.skipped }, 'auto-accept rules: batch accepted');
    return result;
  }

  for (const { album, d, reason } of picks) {
    const took = await acceptCandidate(ctx, {
      libraryId,
      albumId: album.albumId,
      releaseId: d.candidate.releaseId,
      distance: d.candidate.distance,
      source: d.candidate.source || null,
      reason,
    });
    if (!took) continue;
    result.accepted += 1;
    result.acceptedAlbums.push({ albumId: album.albumId, releaseId: d.candidate.releaseId, reason });
    ctx.logger.info({ libraryId, localAlbumId: album.albumId, reason }, 'auto-accept rules: accepted');
  }
  return result;
}

/**
 * Make a candidate the album's live match, as the system. Returns false when
 * the album is no longer waiting for review (decided meanwhile) or the
 * release is no longer stored.
 */
export async function acceptCandidate(ctx: WorkerContext, a: {
  libraryId: string; albumId: string; releaseId: string; distance: number; source: string | null; reason: string;
}): Promise<boolean> {
  const res = await ctx.sql.begin((tx) => acceptInTx(tx, { ...a, status: 'auto', decidedBy: 'system', decidedKind: 'rule' }));
  if (!res.ok) {
    if (res.reason === 'release_gone') {
      ctx.logger.warn({ localAlbumId: a.albumId, releaseId: a.releaseId }, 'auto-accept rules: release no longer stored, not accepted');
    }
    return false;
  }

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
