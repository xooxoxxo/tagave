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
  DiscogsMaster,
  RateLimitInfo,
} from './types.js';

export { MusicBrainzProvider, extractUrlRelations, discogsIdsFromUrlRelations, wikidataQidFromUrlRelations } from './musicbrainz.js';
export type { Edition } from './musicbrainz.js';
export {
  DiscogsProvider,
  parseDiscogsDuration,
  parseDiscogsPosition,
  discogsCountryToIso,
  discogsBarcodeFromIdentifiers,
  discogsBarcodesFromSearchHit,
  mapDiscogsRelease,
  mapDiscogsSearchHit,
  parseDiscogsRef,
  mapCollectionRelease,
  conditionsFromNotes,
  type DiscogsCollectionItem,
} from './discogs.js';
export { WikidataClient, parseWikidataBindings } from './wikidata.js';
export { fuzzyBridgeScore, chooseBestSearchHit, FUZZY_BRIDGE_ACCEPT } from './bridge.js';
export { ProviderGateway } from './gateway.js';
