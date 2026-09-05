import type { DistanceBreakdown } from './types.js';

/**
 * Owner's queue heuristic (2026-09-05): after working the review queue by
 * hand, the pattern held that the top candidate with a wall of green chips is
 * the right release. Chip colors mirror the queue UI exactly:
 * green = component distance 0, yellow = (0, 0.5), red = ≥ 0.5.
 *
 * A candidate passes when it has NO reds and AT LEAST 3 greens; among passing
 * candidates the caller prefers the fewest yellows, then lowest distance.
 */
export interface ChipCounts {
  greens: number;
  yellows: number;
  reds: number;
  passes: boolean;
}

export function chipCounts(breakdown: DistanceBreakdown | Record<string, unknown> | null | undefined): ChipCounts {
  let greens = 0;
  let yellows = 0;
  let reds = 0;
  for (const v of Object.values(breakdown ?? {})) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    if (v === 0) greens += 1;
    else if (v < 0.5) yellows += 1;
    else reds += 1;
  }
  return { greens, yellows, reds, passes: reds === 0 && greens >= 3 };
}

/**
 * Pick the auto-acceptable candidate: passing ones only, fewest yellows wins,
 * distance breaks ties. Returns the winning index or -1.
 */
export function pickByChipRule(
  candidates: { breakdown: DistanceBreakdown | Record<string, unknown> | null; distance: number }[],
): number {
  let winner = -1;
  let winnerCounts: ChipCounts | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]!;
    const counts = chipCounts(cand.breakdown);
    if (!counts.passes) continue;
    if (
      winner === -1 ||
      counts.yellows < winnerCounts!.yellows ||
      (counts.yellows === winnerCounts!.yellows && cand.distance < candidates[winner]!.distance)
    ) {
      winner = i;
      winnerCounts = counts;
    }
  }
  return winner;
}
