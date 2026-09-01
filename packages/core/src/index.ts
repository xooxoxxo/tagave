/**
 * @liner/core - Liner core domain logic
 *
 * Exports:
 * - Text normalization and string distance (spec §12.5)
 * - Matching engine: scoring and track alignment (spec §12.5)
 * - Provider gateway with rate limiting and caching (spec §12.4)
 * - MusicBrainz and Discogs providers (spec IDN-1, ENR-1)
 * - Tag mapping and schema (spec Appendix A)
 */

// Text normalization
export {
  normalizeString,
  normalizeTitle,
  compareStrings,
  jaroWinklerDistance,
  tokenSetRatio,
  stringDistance,
} from './text/index.js';

// Matching engine
export {
  alignTracks,
  scoreRelease,
  scoreCandidates,
  DEFAULT_WEIGHTS,
  MATCHING_THRESHOLDS,
  hungarianAlgorithm,
} from './matching/index.js';

export type {
  LocalTrack,
  LocalAlbumView,
  DistanceBreakdown,
  TrackAlignment,
  MatchingPreferences,
  Assignment,
} from './matching/index.js';

// Matching types (re-exported for convenience)
export type { CanonicalTrack as MatchingCanonicalTrack, ReleaseCandidate as MatchingReleaseCandidate } from './matching/index.js';

// Providers
export {
  MusicBrainzProvider,
  DiscogsProvider,
  ProviderGateway,
} from './providers/index.js';

export type {
  CallContext,
  ExternalId,
  ReleaseQuery,
  CanonicalRelease,
  CanonicalTrack,
  ReleaseCandidate,
  Fingerprint,
  RecordingHit,
  CollectionItem,
  ExternalReview,
  ReviewLink,
  MetadataProvider,
  ReviewProvider,
  CollectionProvider,
  FingerprintProvider,
  WriteOptions,
  TagWriter,
  RateLimitConfig,
  ProviderRateLimitState,
} from './providers/index.js';

// Tag mapping
export {
  TAG_MAPPING,
  MULTI_VALUE_FIELDS,
  getTagNamesForFormat,
  isMultiValueField,
  joinMultiValue,
  splitMultiValue,
} from './tags/index.js';

export type { FormatTagMapping, TagSet } from './tags/index.js';
