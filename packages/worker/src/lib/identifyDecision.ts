/**
 * The matcher's own decision over scored candidates (best first): strong
 * auto-accept, the owner's chip rule inside the review band, the first
 * candidate when nothing is red and the media fit, held for review, or weak.
 * identify.album applies it; the barcode regression report replays it.
 */
import { MATCHING_THRESHOLDS, chipCounts, pickByChipRule } from '@tagave/core';

export interface DecisionCandidate { id: string; distance: number; breakdown: Record<string, unknown>; trackCount: number; mediumCount: number }
export interface DecisionLocal { trackCount: number; discsKnown: boolean; localDiscs: number }
export type IdentifyDecision =
  | { kind: 'strong' | 'chip_rule' | 'first_candidate'; id: string }
  | { kind: 'held' } | { kind: 'weak' } | { kind: 'none' };

export function identifyDecision(scored: DecisionCandidate[], local: DecisionLocal): IdentifyDecision {
  const best = scored[0];
  if (!best) return { kind: 'none' };
  const second = scored[1];
  const gapDemoted = !!second && second.distance - best.distance < MATCHING_THRESHOLDS.recGapThresh
    && second.distance <= MATCHING_THRESHOLDS.medium && best.distance > 0;
  if (best.distance <= MATCHING_THRESHOLDS.strong && best.trackCount === local.trackCount && !gapDemoted) {
    return { kind: 'strong', id: best.id };
  }
  if (best.distance > MATCHING_THRESHOLDS.medium) return { kind: 'weak' };
  const inBand = scored.filter((s) => s.distance <= MATCHING_THRESHOLDS.medium);
  const pick = pickByChipRule(inBand.map((s) => ({ breakdown: s.breakdown, distance: s.distance })));
  if (pick >= 0) return { kind: 'chip_rule', id: inBand[pick]!.id };
  const cc = chipCounts(best.breakdown);
  if (cc.reds === 0 && (!local.discsKnown || best.mediumCount === 0 || best.mediumCount <= local.localDiscs)) {
    return { kind: 'first_candidate', id: best.id };
  }
  return { kind: 'held' };
}
