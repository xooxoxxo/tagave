/**
 * Matching engine: scoring and track alignment.
 * Implements spec §12.5 matching algorithm.
 */

import { stringDistance, normalizeString } from '../text/normalize.js';
import { hungarianAlgorithm } from './hungarian.js';
import type {
  LocalAlbumView,
  CanonicalRelease,
  MatchingPreferences,
  TrackAlignment,
  DistanceBreakdown,
  LocalTrack,
  CanonicalTrack,
} from './types.js';
import {
  DEFAULT_WEIGHTS,
  MATCHING_THRESHOLDS,
} from './types.js';

/**
 * Align local tracks to canonical tracks using the Hungarian algorithm.
 * Cost is 0.6*titleDistance + 0.4*lengthDistance with grace (10s) and hard cap (30s).
 *
 * @param localTracks - tracks from the user's files
 * @param canonicalTracks - tracks from the canonical release
 * @returns Array of alignments for each local track
 */
export function alignTracks(
  localTracks: LocalTrack[],
  canonicalTracks: CanonicalTrack[]
): TrackAlignment[] {
  const GRACE_DURATION = 10; // seconds
  const HARD_CAP_DURATION = 30; // seconds
  const IMPOSSIBLE_COST = 1000; // High cost for forbidden assignment

  if (!localTracks.length || !canonicalTracks.length) {
    return localTracks.map((track) => ({
      localIndex: track.index,
      canonicalIndex: null,
      distance: 1,
      title: { local: track.title },
      duration: { local: track.duration },
    }));
  }

  // Build cost matrix
  const costMatrix: number[][] = [];
  for (const localTrack of localTracks) {
    const row: number[] = [];
    for (const canTrack of canonicalTracks) {
      // Calculate title distance
      const titleDist = stringDistance(localTrack.title, canTrack.title);

      // Calculate duration distance (normalized to 0-1)
      const durationDiff = Math.abs(localTrack.duration - canTrack.duration);

      // Hard cap: forbid assignment if >30s difference
      if (durationDiff > HARD_CAP_DURATION) {
        row.push(IMPOSSIBLE_COST);
        continue;
      }

      // Grace period: no penalty for ≤10s difference
      let durationDist = 0;
      if (durationDiff > GRACE_DURATION) {
        const excessDiff = durationDiff - GRACE_DURATION;
        // Normalize to 0-1 range based on remaining time to hard cap
        durationDist = excessDiff / (HARD_CAP_DURATION - GRACE_DURATION);
      }

      // Combined cost: 0.6*title + 0.4*length
      const cost = 0.6 * titleDist + 0.4 * durationDist;
      row.push(cost);
    }
    costMatrix.push(row);
  }

  // Solve assignment problem
  const assignment = hungarianAlgorithm(costMatrix);

  // Convert to TrackAlignment results
  const alignments: TrackAlignment[] = [];
  for (let i = 0; i < localTracks.length; i++) {
    const localTrack = localTracks[i]!;
    const canonicalIndex = assignment.mapping[i] ?? -1;

    if (canonicalIndex !== -1 && canonicalIndex >= 0 && canonicalIndex < canonicalTracks.length) {
      const cost = costMatrix[i]?.[canonicalIndex];
      if (cost !== undefined && cost < IMPOSSIBLE_COST) {
        const canTrack = canonicalTracks[canonicalIndex]!;
        alignments.push({
          localIndex: localTrack.index,
          canonicalIndex: canTrack.index,
          distance: cost,
          title: { local: localTrack.title, canonical: canTrack.title },
          duration: { local: localTrack.duration, canonical: canTrack.duration },
        });
      } else {
        alignments.push({
          localIndex: localTrack.index,
          canonicalIndex: null,
          distance: 1,
          title: { local: localTrack.title },
          duration: { local: localTrack.duration },
        });
      }
    } else {
      alignments.push({
        localIndex: localTrack.index,
        canonicalIndex: null,
        distance: 1,
        title: { local: localTrack.title },
        duration: { local: localTrack.duration },
      });
    }
  }

  return alignments;
}

/**
 * Score a candidate release against a local album.
 * Lower scores are better (0 = perfect match).
 *
 * @param local - local album cluster
 * @param candidate - candidate release to score
 * @param prefs - matching preferences
 * @returns { distance, breakdown, recommendation }
 */
export function scoreRelease(
  local: LocalAlbumView,
  candidate: CanonicalRelease,
  prefs: MatchingPreferences = {}
): { distance: number; breakdown: DistanceBreakdown; recommendation: 'strong' | 'medium' | 'weak' } {
  const weights = { ...DEFAULT_WEIGHTS, ...(prefs.weights || {}) };
  const breakdown: DistanceBreakdown = {};

  let totalScore = 0;
  let totalWeight = 0;

  // 1. Embedded MBID match (highest priority)
  if (local.embeddedMbId && candidate.id === local.embeddedMbId) {
    breakdown.albumId = 0;
    // Don't add to total if perfect match
  } else if (local.embeddedMbRgId && candidate.releaseGroupId === local.embeddedMbRgId) {
    breakdown.albumId = 0;
  } else if (local.embeddedMbId || local.embeddedMbRgId) {
    // Mismatch on embedded ID is a large penalty
    breakdown.albumId = 1;
    totalScore += 1 * weights.albumId;
    totalWeight += weights.albumId;
  }

  // 2. Artist comparison
  const localArtist = normalizeString(local.albumartist || local.artist || '');
  const canArtists = (candidate.artists || []).map((a) => normalizeString(a));
  let artistDist = 1;
  if (localArtist && canArtists.length > 0) {
    // Take the best match from artist credits
    artistDist = Math.min(
      ...canArtists.map((a) => stringDistance(localArtist, a))
    );
  }
  breakdown.artist = artistDist;
  totalScore += artistDist * weights.artist;
  totalWeight += weights.artist;

  // 3. Album title comparison
  const albumDist = stringDistance(local.title, candidate.title);
  breakdown.album = albumDist;
  totalScore += albumDist * weights.album;
  totalWeight += weights.album;

  // 4. Track alignment and count comparison
  const alignments = alignTracks(local.tracks, candidate.tracks);
  let missingCount = 0;
  let unmatchedCount = 0;
  let trackDistSum = 0;

  for (const alignment of alignments) {
    if (alignment.canonicalIndex === null) {
      unmatchedCount++;
    }
    trackDistSum += alignment.distance;
  }

  for (const canTrack of candidate.tracks) {
    const matched = alignments.some((a) => a.canonicalIndex === canTrack.index);
    if (!matched) {
      missingCount++;
    }
  }

  // Track count distance
  const trackCountDist =
    Math.abs(local.tracks.length - candidate.tracks.length) /
    Math.max(local.tracks.length, candidate.tracks.length);

  breakdown.tracks = trackCountDist;
  totalScore += trackCountDist * weights.tracks;
  totalWeight += weights.tracks;

  // Per-track title distance (average across aligned tracks)
  const alignedTitles = alignments.filter((a) => a.canonicalIndex !== null);
  if (alignedTitles.length > 0) {
    const avgTitleDist =
      alignedTitles.reduce((sum, a) => sum + stringDistance(a.title.local, a.title.canonical || ''), 0) /
      alignedTitles.length;
    breakdown.trackTitle = avgTitleDist;
    totalScore += avgTitleDist * weights.trackTitle;
    totalWeight += weights.trackTitle;
  }

  // Missing and unmatched tracks penalties
  if (missingCount > 0) {
    breakdown.missingTracks = Math.min(1, missingCount / candidate.tracks.length);
    totalScore += breakdown.missingTracks * weights.missingTracks;
    totalWeight += weights.missingTracks;
  }

  if (unmatchedCount > 0) {
    breakdown.unmatchedTracks = Math.min(1, unmatchedCount / local.tracks.length);
    totalScore += breakdown.unmatchedTracks * weights.unmatchedTracks;
    totalWeight += weights.unmatchedTracks;
  }

  // 5. Year comparison (if available)
  if (local.year && candidate.year) {
    const yearDist = Math.min(1, Math.abs(local.year - candidate.year) / 100);
    breakdown.year = yearDist;
    totalScore += yearDist * weights.year;
    totalWeight += weights.year;
  }

  // 6. Country comparison
  if (local.country && candidate.country) {
    const countryDist = local.country === candidate.country ? 0 : 1;
    breakdown.country = countryDist;
    totalScore += countryDist * weights.country;
    totalWeight += weights.country;
  } else if (prefs.countries && candidate.country && prefs.countries.includes(candidate.country)) {
    breakdown.country = 0;
    totalScore += 0;
    totalWeight += weights.country;
  }

  // 7. Media comparison
  if (local.media && candidate.media) {
    const mediaDist = local.media === candidate.media ? 0 : 1;
    breakdown.media = mediaDist;
    totalScore += mediaDist * weights.media;
    totalWeight += weights.media;
  }

  // 8. Label and catalog number
  if (local.catalogNumber && candidate.catalogNumber) {
    const catDist = local.catalogNumber === candidate.catalogNumber ? 0 : 0.5;
    breakdown.catalogNum = catDist;
    totalScore += catDist * weights.catalogNum;
    totalWeight += weights.catalogNum;
  }

  // 9. Barcode comparison
  if (local.barcode && candidate.barcode) {
    if (local.barcode === candidate.barcode) {
      breakdown.albumId = 0;
    } else {
      // Barcode mismatch is moderately important
      breakdown.albumId = (breakdown.albumId || 0) + 0.3;
    }
  }

  // 10. Data source preference
  if (prefs.preferredDataSource && candidate.source !== prefs.preferredDataSource) {
    breakdown.dataSource = 0.5;
    totalScore += 0.5 * weights.dataSource;
    totalWeight += weights.dataSource;
  }

  // Normalize score to 0-1 range
  const normalizedDistance = totalWeight > 0 ? totalScore / totalWeight : 1;

  // Determine recommendation level
  let recommendation: 'strong' | 'medium' | 'weak' = 'weak';
  if (normalizedDistance <= MATCHING_THRESHOLDS.strong) {
    recommendation = 'strong';
  } else if (normalizedDistance <= MATCHING_THRESHOLDS.medium) {
    recommendation = 'medium';
  }

  // Demote to medium if tracks are missing or unmatched (spec IDN-3)
  if ((missingCount > 0 || unmatchedCount > 0) && recommendation === 'strong') {
    recommendation = 'medium';
  }

  return {
    distance: normalizedDistance,
    breakdown,
    recommendation,
  };
}

/**
 * Score multiple candidates and rank them.
 */
export function scoreCandidates(
  local: LocalAlbumView,
  candidates: CanonicalRelease[],
  prefs: MatchingPreferences = {}
): Array<CanonicalRelease & { distance: number; breakdown: DistanceBreakdown; recommendation: 'strong' | 'medium' | 'weak' }> {
  return candidates
    .map((candidate) => {
      const { distance, breakdown, recommendation } = scoreRelease(local, candidate, prefs);
      return {
        ...candidate,
        distance,
        breakdown,
        recommendation,
      };
    })
    .sort((a, b) => a.distance - b.distance);
}
