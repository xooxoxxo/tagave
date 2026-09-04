/**
 * Bridge utilities for matching MusicBrainz and Discogs releases.
 * Implements spec §10.2.4.
 */
import { stringDistance, tokenSetRatio } from '../text/index.js';

/**
 * Fuzzy bridge score threshold for accepting a match.
 */
export const FUZZY_BRIDGE_ACCEPT = 0.85;

/**
 * Calculate a fuzzy match score between MusicBrainz and search hit metadata.
 *
 * Weights:
 * - Title: 0.5
 * - Artist(s): 0.35
 * - Year: 0.15
 *
 * Returns a score from 0 to 1.
 */
export function fuzzyBridgeScore(
  mb: { title: string; artists: string[]; year?: number },
  hit: { title: string; artists: string[]; year?: number }
): number {
  let score = 0;

  // Title similarity: 1 - stringDistance (normalized to 0-1)
  const titleDistance = stringDistance(mb.title, hit.title);
  const maxLen = Math.max(mb.title.length, hit.title.length);
  const titleScore = 1 - (titleDistance / maxLen);
  score += titleScore * 0.5;

  // Artist similarity: tokenSetRatio on joined credits
  const mbArtistsJoined = mb.artists.join(' ');
  const hitArtistsJoined = hit.artists.join(' ');
  const artistScore = tokenSetRatio(mbArtistsJoined, hitArtistsJoined);
  score += artistScore * 0.35;

  // Year proximity
  let yearScore = 0.5; // Unknown years are neutral
  if (mb.year !== undefined && hit.year !== undefined) {
    const yearDiff = Math.abs(mb.year - hit.year);
    if (yearDiff === 0) {
      yearScore = 1;
    } else if (yearDiff === 1) {
      yearScore = 0.6;
    } else if (yearDiff <= 3) {
      yearScore = 0.3;
    } else {
      yearScore = 0;
    }
  }
  score += yearScore * 0.15;

  return score;
}

/**
 * Choose the best search hit from candidates based on fuzzy scoring.
 *
 * Returns the best candidate with score ≥ FUZZY_BRIDGE_ACCEPT, or null.
 */
export function chooseBestSearchHit(
  candidates: Array<{ title: string; artists: string[]; year?: number }>,
  target: { title: string; artists: string[]; year?: number }
): { index: number; score: number } | null {
  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < candidates.length; i++) {
    const score = fuzzyBridgeScore(target, candidates[i]!);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestScore >= FUZZY_BRIDGE_ACCEPT && bestIndex >= 0) {
    return { index: bestIndex, score: bestScore };
  }

  return null;
}
