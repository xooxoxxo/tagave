/**
 * Matching engine: scoring and track alignment.
 */
export {
  alignTracks,
  scoreRelease,
  scoreCandidates,
  mediumCountOf,
  MAX_ALIGN_TRACKS,
} from './scoring.js';

export type { MediumCountSource } from './scoring.js';

export type {
  LocalTrack,
  CanonicalTrack,
  LocalAlbumView,
  CanonicalRelease,
  ReleaseCandidate,
  DistanceBreakdown,
  TrackAlignment,
  MatchingPreferences,
} from './types.js';

export {
  DEFAULT_WEIGHTS,
  MATCHING_THRESHOLDS,
} from './types.js';

export { chipCounts, pickByChipRule } from './chipRule.js';
export type { ChipCounts } from './chipRule.js';

export { hungarianAlgorithm } from './hungarian.js';
export type { Assignment } from './hungarian.js';
