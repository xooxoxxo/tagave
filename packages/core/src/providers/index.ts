/**
 * Provider gateway, implementations, and types.
 */
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
} from './types.js';

export { MusicBrainzProvider } from './musicbrainz.js';
export { DiscogsProvider } from './discogs.js';
export { ProviderGateway } from './gateway.js';
