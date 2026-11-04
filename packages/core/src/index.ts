/**
 * @tagave/core - tagave core domain logic
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
  mediumCountOf,
  DEFAULT_WEIGHTS,
  MATCHING_THRESHOLDS,
  MAX_ALIGN_TRACKS,
  hungarianAlgorithm,
  chipCounts,
  pickByChipRule,
  evaluateAutoAccept,
  rulesFromStored,
} from './matching/index.js';

export type {
  LocalTrack,
  LocalAlbumView,
  DistanceBreakdown,
  TrackAlignment,
  MatchingPreferences,
  MediumCountSource,
  Assignment,
  RuleCandidate,
  AutoAcceptDecision,
} from './matching/index.js';

// Matching types (re-exported for convenience)
export type { CanonicalTrack as MatchingCanonicalTrack, ReleaseCandidate as MatchingReleaseCandidate } from './matching/index.js';

// Providers
export {
  MusicBrainzProvider,
MB_BROWSE_LIMIT,
  mbPartialDateToSql,
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
  AcoustIdClient,
  AcoustIdError,
  acoustIdResponseSchema,
  flattenAcoustIdResults,
  rankAcoustIdReleases,
  fuzzyBridgeScore,
  chooseBestSearchHit,
  FUZZY_BRIDGE_ACCEPT,
} from './providers/index.js';

export type {
  AcoustIdRecording,
  AcoustIdRelease,
  AcoustIdClientOptions,
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
  EditionsPage,
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
  lintAlbum,
} from './tags/index.js';

export type { FormatTagMapping, TagSet, ResolvedField, ResolvedMetadata, ResolutionInput, FieldLock, LintFlag, LintToggles, RawTrackTags } from './tags/index.js';

// CUE sheets
export { decodeCueBytes, parseCueSheet, virtualTracksForFile, matchCueFileToAudio, chooseCueForAudio } from './cue/index.js';

export type { CueSheet, CueFile, CueTrack, VirtualTrack, CueCandidate } from './cue/index.js';

// Review link-outs (REV-2)
export { SEARCH_TEMPLATES, resolveReviewLinks, sourceFromUrl } from './reviews/index.js';
export type { LinkIdentity, LinkInputs, ResolvedLink } from './reviews/index.js';

// Build identity (PLT-5 / XO-313)
export { readBuildInfo } from './build/info.js';
export type { BuildInfo } from './build/info.js';
export { defaultCacheDir } from './build/cacheDir.js';

// Credential encryption
export { sealSecret, openSecret, isSealed, computeHint } from './crypto/secretbox.js';

// Genre canonicalisation (XO-310) and follow rules (XO-301)
export {
  DEFAULT_GENRE_MAP,
  normalizeGenreMap,
  effectiveGenres,
  DEFAULT_FOLLOW_RULES,
  normalizeFollowRules,
} from './genres/index.js';

export type {
  GenreMap,
  FollowRules,
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

// Whole album in one file: cut points, file names, the written tracks' check (0078)
export {
  expectedBoundariesMs, msToSample, frameSamplesOf, frameRms, sustained, refineCut, confidenceOf, windowAround,
  safeNamePart, trackFileName, planSplit, verifySplit, FRAME_MS, MIN_DIP_DB, SURE_DIP_DB,
} from './audio/splitImage.js';
export type { RefinedCut, RefineInput, PlanInput, PlanTrackInput, WrittenTrack } from './audio/splitImage.js';

// Move to album: the names a moved file and a new album folder take (0080)
export { DEFAULT_NAMING, namingOf, folderNaming, describeNaming, movedFileName, newAlbumDir } from './audio/moveNaming.js';
export type { NamingPattern, NameInput } from './audio/moveNaming.js';

// Physical collection: format lines and one-click album suggestions
export { physicalFormatLabel, discogsArtistName, matchTitle, scoreSuggestion, rankPhysicalSuggestions } from './collection/index.js';
export type { PhysicalRecordInfo, LibraryAlbumCandidate, RankedSuggestion } from './collection/index.js';

// Worker queues and the work each serves
export { WORKER_QUEUES, GATED_QUEUES, QUEUES_RIDING_WITH, unservedWork } from './queues.js';

// Artists list ordering (api live list, worker artist_list rebuild)
export {
  orderArtists, artistListPositions, parseArtistSort, parseArtistGroup, ARTIST_SORTS,
  type ArtistRow, type ArtistSort, type ArtistGroupCount, type OrderedArtists, type ArtistPositions,
} from './artistList.js';

// Naming rules (vault "tagave - Naming Rules and Drop Pool"): where a file belongs, from its tags
export {
  NAMING_VARIABLES, DEFAULT_NAMING_RULES, DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE, DEFAULT_SPECIAL_RULES, DEFAULT_LEAVE_ALONE,
  SEGMENT_MAX_BYTES, PATH_MAX_BYTES, INITIAL_NUMERIC, INITIAL_OTHER, DETECT_MIN_SHARE,
  initialOf, templateProblem, rulesProblems, safeSegment, capPath, folderRuleFor, ruleDir, ruleFileName, rulePath,
  isLeftAlone, samePath, namingValuesOf, detectNaming, albumPaths,
} from './naming/rules.js';
export type {
  NamingRules, NamingValues, NamingVariable, SpecialRule, SpecialWhen, RulePath, RuleName, NamingSample, Detected, AlbumFileInput, AlbumPaths,
} from './naming/rules.js';
export { currentFieldsFrom } from './naming/currentFields.js';
export type { CanonicalValue } from './naming/currentFields.js';
