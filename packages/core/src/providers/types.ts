/**
 * Provider gateway types and interfaces.
 * Spec §12.4, §10.2
 */
import type { CanonicalField, TagSet } from '@liner/shared';

/**
 * Call context with priority for rate limiting.
 */
export interface CallContext {
  /** 'interactive' for user-initiated calls, 'background' for jobs */
  priority: 'interactive' | 'background';
  /** Optional request ID for logging */
  requestId?: string;
  /** Optional parent job ID for tracing */
  jobId?: string;
}

/**
 * External identifier reference.
 */
export type ExternalId = {
  provider: 'musicbrainz' | 'discogs';
  id: string;
};

/**
 * Query for release search.
 */
export interface ReleaseQuery {
  artistName?: string;
  albumTitle: string;
  trackCount?: number;
  barcode?: string;
  catalogNumber?: string;
  year?: number;
}

/**
 * Canonical release data from provider.
 */
export interface CanonicalRelease {
  id: string; // MusicBrainz release ID or Discogs release ID
  releaseGroupId: string; // MusicBrainz release group ID or Discogs master ID
  title: string;
  artists: string[]; // artist credits
  tracks: CanonicalTrack[];
  year?: number | undefined;
  date?: string | undefined; // YYYY-MM-DD
  country?: string | undefined;
  barcode?: string | undefined;
  catalogNumber?: string | undefined;
  media?: string | undefined; // e.g., "CD", "Vinyl"
  status?: string | undefined; // e.g., "Official", "Promotion"
  label?: string | undefined;
  source: 'musicbrainz' | 'discogs';
  sourceId?: string | undefined; // e.g., Discogs release or master ID
}

/**
 * Track on a canonical release.
 */
export interface CanonicalTrack {
  title: string;
  artists: string[];
  duration: number; // milliseconds
  position: number; // 1-based
  mediumNumber: number; // 1-based
  recordingId?: string | undefined; // MusicBrainz recording MBID
  isrc?: string | undefined;
  isDataTrack?: boolean | undefined;
  isVideoTrack?: boolean | undefined;
}

/**
 * Release candidate from search or lookup.
 */
export interface ReleaseCandidate {
  release: CanonicalRelease;
  source: 'mbid' | 'mb_search' | 'discogs_search' | 'acoustid' | 'manual';
}

/**
 * Fingerprint for AcoustID lookup.
 */
export interface Fingerprint {
  chromaprintHash: string;
  duration: number; // seconds
}

/**
 * Recording hit from fingerprint lookup.
 */
export interface RecordingHit {
  recordingId: string;
  releaseIds: string[];
  releaseGroupIds: string[];
  score: number;
}

/**
 * Collection item from Discogs.
 */
export interface CollectionItem {
  providerItemId: string; // e.g., Discogs collection item ID
  discogsReleaseId: string;
  folder: string;
  mediaCondition?: string;
  sleeveCondition?: string;
  rating?: number;
  notes?: string;
  dateAdded: Date;
  formats?: string[];
}

/**
 * External review from provider.
 */
export interface ExternalReview {
  source: 'critiquebrainz' | 'wikipedia' | 'discogs' | 'musicbrainz';
  sourceId?: string;
  url?: string;
  author?: string;
  title?: string;
  bodyText?: string;
  excerpt?: string;
  ratingRaw?: number;
  ratingScale?: number; // e.g., 100 for percent, 5 for 0-5
  license?: string; // e.g., "CC BY-SA 3.0"
  publishedAt?: Date;
}

/**
 * Link to a review (not the review itself).
 */
export interface ReviewLink {
  source: string; // e.g., 'metacritic', 'pitchfork'
  url: string;
  discoveredVia: 'wikidata' | 'mb_relationship' | 'template';
}

/**
 * Provider metadata.
 */
export interface MetadataProvider {
  id: string;
  name: string;
  capabilities: Set<
    | 'searchReleases'
    | 'getRelease'
    | 'getReleaseGroup'
    | 'getArtist'
    | 'getArtistReleaseGroups'
    | 'getImages'
    | 'lookupByBarcode'
    | 'lookupByIds'
  >;

  searchReleases(
    q: ReleaseQuery,
    ctx: CallContext
  ): Promise<ReleaseCandidate[]>;

  getRelease?(id: string, ctx: CallContext): Promise<CanonicalRelease>;
  getReleaseGroup?(id: string, ctx: CallContext): Promise<CanonicalRelease>;
  getArtist?(id: string, ctx: CallContext): Promise<{ id: string; name: string }>;
  getArtistReleaseGroups?(
    artistId: string,
    ctx: CallContext
  ): Promise<CanonicalRelease[]>;
}

/**
 * Review data provider.
 */
export interface ReviewProvider {
  id: string;
  getReviews(releaseGroupId: string, ctx: CallContext): Promise<ExternalReview[]>;
  getLinks?(releaseGroupId: string, ctx: CallContext): Promise<ReviewLink[]>;
}

/**
 * Collection data provider.
 */
export interface CollectionProvider {
  id: string;
  listItems(
    cursor?: string,
    ctx?: CallContext
  ): AsyncIterable<CollectionItem>;
}

/**
 * Fingerprint provider.
 */
export interface FingerprintProvider {
  id: string;
  lookup(fp: Fingerprint, ctx: CallContext): Promise<RecordingHit[]>;
}

/**
 * Options for tag writing.
 */
export interface WriteOptions {
  id3Version?: '2.3' | '2.4'; // default 2.4
  multiValueSeparator?: string; // default '; '
  stripUnknown?: boolean; // default false
  preserveEmbeddedArt?: boolean; // always true in v1
}

/**
 * Tag writer implementation.
 */
export interface TagWriter {
  id: string;
  read(path: string): Promise<TagSet>;
  write(path: string, tags: TagSet, opts?: WriteOptions): Promise<void>;
  supports(container: string): boolean;
}

/**
 * Rate limiter state and configuration.
 */
export interface RateLimitConfig {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  concurrency?: number;
  /** Circuit breaker: open after this many consecutive failures */
  failureThreshold?: number;
  /** Circuit breaker: open for this many milliseconds */
  openDurationMs?: number;
  /** Backoff multiplier for retries */
  backoffMultiplier?: number;
  /** Maximum backoff duration in milliseconds */
  maxBackoffMs?: number;
}

/**
 * Provider rate limit state (for persistence).
 */
export interface ProviderRateLimitState {
  provider: string;
  windowStartedAt: Date;
  requestsUsed: number;
  circuitOpenUntil?: Date | undefined;
  lastErrorAt?: Date | undefined;
}
