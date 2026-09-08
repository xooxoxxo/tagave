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
  MAX_ALIGN_TRACKS,
  hungarianAlgorithm,
  chipCounts,
  pickByChipRule,
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
  WikidataClient,
  ProviderGateway,
  parseDiscogsDuration,
  parseDiscogsPosition,
  discogsCountryToIso,
  discogsBarcodeFromIdentifiers,
  discogsBarcodesFromSearchHit,
  mapDiscogsRelease,
  mapDiscogsSearchHit,
  mapCollectionRelease,
  conditionsFromNotes,
  parseDiscogsRef,
  extractUrlRelations,
  discogsIdsFromUrlRelations,
  wikidataQidFromUrlRelations,
  parseWikidataBindings,
  pickIdentityBinding,
  CritiqueBrainzClient,
  critiqueBrainzLicense,
  mapCritiqueBrainzReview,
  WikipediaClient,
  findReceptionSection,
  wikiHtmlToText,
  fuzzyBridgeScore,
  chooseBestSearchHit,
  FUZZY_BRIDGE_ACCEPT,
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
  DiscogsMaster,
  RateLimitInfo,
  ArtistCredit,
  WeightedTag,
  Edition,
  MbArtist,
  ReleaseGroupIdentity,
  WikidataBinding,
  ArtistIdentity,
  ReceptionSection,
  WikiSection,
  IntroExtract,
  DiscogsCollectionItem,
} from './providers/index.js';

// Tag mapping
export {
  TAG_MAPPING,
  MULTI_VALUE_FIELDS,
  getTagNamesForFormat,
  isMultiValueField,
  joinMultiValue,
  splitMultiValue,
  resolveFields,
} from './tags/index.js';

export type { FormatTagMapping, TagSet, ResolvedField, ResolvedMetadata, ResolutionInput, FieldLock } from './tags/index.js';

// CUE sheets
export { decodeCueBytes, parseCueSheet, virtualTracksForFile, matchCueFileToAudio, chooseCueForAudio } from './cue/index.js';

export type { CueSheet, CueFile, CueTrack, VirtualTrack, CueCandidate } from './cue/index.js';

// Review link-outs (REV-2)
export { SEARCH_TEMPLATES, resolveReviewLinks, sourceFromUrl } from './reviews/index.js';
export type { LinkIdentity, LinkInputs, ResolvedLink } from './reviews/index.js';

// Build identity (PLT-5 / XO-313)
export { readBuildInfo } from './build/info.js';
export type { BuildInfo } from './build/info.js';

// Credential encryption
export { sealSecret, openSecret, isSealed, computeHint } from './crypto/secretbox.js';

// Genre canonicalisation (XO-310)
export {
  DEFAULT_GENRE_MAP,
  normalizeGenreMap,
  effectiveGenres,
} from './genres/index.js';

export type {
  GenreMap,
  RawTag,
  EffectiveGenres,
} from './genres/index.js';

// Audio-stream hashing (XO-350)
export {
  hashAudioStream,
  hashFlacStream,
  hashMp3Stream,
  hashMp4Stream,
  hashOggStream,
  hashWavStream,
  hashAiffStream,
  hashDsfStream,
  hashDffStream,
} from './audio/streamHash.js';
