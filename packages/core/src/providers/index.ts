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
  ArtistCredit,
  WeightedTag,
} from './types.js';

export { MusicBrainzProvider, extractUrlRelations, discogsIdsFromUrlRelations, wikidataQidFromUrlRelations } from './musicbrainz.js';
export type { Edition, MbArtist } from './musicbrainz.js';
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
export { WikidataClient, parseWikidataBindings, pickIdentityBinding } from './wikidata.js';
export type { ReleaseGroupIdentity, WikidataBinding, ArtistIdentity } from './wikidata.js';
export { CritiqueBrainzClient, critiqueBrainzLicense, mapCritiqueBrainzReview } from './critiquebrainz.js';
export { WikipediaClient, findReceptionSection, wikiHtmlToText } from './wikipedia.js';
export { AcoustIdClient, AcoustIdError, acoustIdResponseSchema, flattenResults as flattenAcoustIdResults, rankReleases as rankAcoustIdReleases } from './acoustid.js';
export type { AcoustIdRecording, AcoustIdRelease, AcoustIdClientOptions } from './acoustid.js';
export type { ReceptionSection, WikiSection, IntroExtract } from './wikipedia.js';
export { fuzzyBridgeScore, chooseBestSearchHit, FUZZY_BRIDGE_ACCEPT } from './bridge.js';
export { ProviderGateway } from './gateway.js';
