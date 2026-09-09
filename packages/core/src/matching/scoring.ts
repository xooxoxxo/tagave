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
 * Largest tracklist the alignment will consider. The Hungarian solver pads
 * to a square of the larger side (O(n³)): a 6-track album against a
 * 6,666-track Discogs compilation froze the identify worker for ten
 * minutes (2026-09-06). Nothing in a personal archive is that big, so
 * such a candidate is simply "no alignment" (distance 1 per track).
 */
export const MAX_ALIGN_TRACKS = 500;

/** A local track nothing could be paired with. */
function unaligned(track: LocalTrack): TrackAlignment {
  return {
    localIndex: track.index,
    canonicalIndex: null,
    distance: 1,
    title: { local: track.title },
    duration: { local: track.duration },
  };
}

/**
 * Align local tracks to canonical tracks using the Hungarian algorithm.
 * Cost is 0.6*titleDistance + 0.4*lengthDistance with grace (10s) and hard cap (30s).
 *
 * When the local cluster knows its disc numbers and the candidate says which
 * medium each track sits on, the alignment runs per medium (disc N against
 * medium N) instead of over one flat list: a two-CD folder pair must not
 * silently align its disc-2 tracks against a one-CD release's tracklist
 * (XO-379, the "Liebe ist für alle da" CD1/CD2 mismatch). Local tracks whose
 * disc has no matching medium — and canonical tracks on a medium no local
 * disc covers — stay unaligned, so they land in unmatchedTracks/missingTracks.
 * With no disc information on the local side the flat alignment is used
 * unchanged.
 *
 * @param localTracks - tracks from the user's files
 * @param canonicalTracks - tracks from the canonical release
 * @returns Array of alignments, one per local track, in input order
 */
export function alignTracks(
  localTracks: LocalTrack[],
  canonicalTracks: CanonicalTrack[]
): TrackAlignment[] {
  if (!localTracks.length || !canonicalTracks.length
    || Math.max(localTracks.length, canonicalTracks.length) > MAX_ALIGN_TRACKS) {
    return localTracks.map(unaligned);
  }

  // Unknown discs (or a candidate that never says which medium a track is on,
  // e.g. a provider shape built before this existed) => the historical
  // behaviour, byte for byte.
  const localHasDiscs = localTracks.some((t) => t.disc !== undefined);
  const canonicalHasMedia = canonicalTracks.some((t) => t.medium !== undefined);
  if (!localHasDiscs || !canonicalHasMedia) return alignFlat(localTracks, canonicalTracks);

  const byMedium = new Map<number, CanonicalTrack[]>();
  for (const t of canonicalTracks) {
    const m = t.medium ?? 1; // a mediumless track on a multi-medium release is disc 1
    const bucket = byMedium.get(m);
    if (bucket) bucket.push(t);
    else byMedium.set(m, [t]);
  }

  // Local positions per disc; a missing disc number means disc 1 (the
  // convention local_tracks.disc_no is written with).
  const byDisc = new Map<number, number[]>();
  for (let i = 0; i < localTracks.length; i++) {
    const d = localTracks[i]!.disc ?? 1;
    const bucket = byDisc.get(d);
    if (bucket) bucket.push(i);
    else byDisc.set(d, [i]);
  }

  const out: TrackAlignment[] = new Array(localTracks.length);
  for (const [disc, positions] of byDisc) {
    const group = positions.map((i) => localTracks[i]!);
    const medium = byMedium.get(disc);
    const sub = medium && medium.length ? alignFlat(group, medium) : group.map(unaligned);
    for (let k = 0; k < positions.length; k++) {
      out[positions[k]!] = sub[k] ?? unaligned(group[k]!);
    }
  }
  return out;
}

/**
 * Flat Hungarian alignment over two tracklists (one medium, or a whole
 * release when discs are unknown).
 */
function alignFlat(
  localTracks: LocalTrack[],
  canonicalTracks: CanonicalTrack[]
): TrackAlignment[] {
  const GRACE_DURATION = 10; // seconds
  const HARD_CAP_DURATION = 30; // seconds
  const IMPOSSIBLE_COST = 1000; // High cost for forbidden assignment

  if (!localTracks.length || !canonicalTracks.length
    || Math.max(localTracks.length, canonicalTracks.length) > MAX_ALIGN_TRACKS) {
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

      // Unknown canonical duration (most Discogs releases carry none): the
      // duration says nothing, so the cost is the title alone — a 0 s
      // "duration" used to hit the hard cap and forbid every assignment,
      // which is why Discogs matches scored ~10× worse than MusicBrainz ones.
      if (!canTrack.duration || !localTrack.duration) {
        row.push(titleDist);
        continue;
      }

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

  // Disc count vs medium count (XO-379). A two-CD cluster is not the one-CD
  // release, however well half of it aligns; scaled like the track count and
  // weighted the same, so a mismatch shows up as a red chip.
  if (local.discCount !== undefined && candidate.mediumCount !== undefined
    && local.discCount > 0 && candidate.mediumCount > 0) {
    const mediumCountDist =
      Math.abs(local.discCount - candidate.mediumCount) /
      Math.max(local.discCount, candidate.mediumCount);
    breakdown.mediums = mediumCountDist;
    totalScore += mediumCountDist * weights.mediums;
    totalWeight += weights.mediums;
  }

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
