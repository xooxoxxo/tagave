/**
 * Matching engine: scoring and track alignment.
 */
export {
  alignTracks,
  scoreRelease,
  scoreCandidates,
  mediumCountOf,
  normalizeBarcode,
  MAX_ALIGN_TRACKS,
} from './scoring.js';

export type { MediumCountSource, ReleaseScore } from './scoring.js';

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

export {
  buildAlbumEvidence,
  buildCandidateEvidence,
  evidenceHash,
  stableJson,
  EVIDENCE_VERSION,
} from './evidence.js';
export type {
  TitleSource,
  YearSource,
  LocalTrackEvidence,
  AlbumEvidence,
  RemoteFacts,
  RemoteTrack,
  AlignTriple,
  CandidateEvidence,
  AlbumEvidenceInput,
  RemoteInput,
  EvidenceCandidate,
} from './evidence.js';

export { hungarianAlgorithm } from './hungarian.js';
export type { Assignment } from './hungarian.js';

export { evaluateAutoAccept, rulesFromStored } from './autoAcceptRules.js';
export type { RuleCandidate, AutoAcceptDecision } from './autoAcceptRules.js';
