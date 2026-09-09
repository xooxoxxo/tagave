/**
 * Types for the matching engine.
 * Based on spec §12.5 and IDN-1/IDN-2.
 */

/**
 * A local track from the user's files.
 */
export interface LocalTrack {
  title: string;
  artist?: string;
  duration: number; // seconds
  index: number; // 0-based track number
}

/**
 * A canonical track from a provider (MusicBrainz release).
 */
export interface CanonicalTrack {
  title: string;
  artist?: string;
  duration: number; // seconds
  index: number; // 0-based track number
  recordingId?: string;
}

/**
 * A local album cluster from the scanner.
 */
export interface LocalAlbumView {
  artist: string;
  albumartist?: string;
  title: string;
  tracks: LocalTrack[];
  year?: number;
  country?: string;
  barcode?: string;
  catalogNumber?: string;
  media?: string; // e.g., "CD", "Digital Media"
  embeddedMbId?: string;
  embeddedMbRgId?: string;
}

/**
 * A canonical release from a provider.
 */
export interface CanonicalRelease {
  id: string;
  releaseGroupId: string;
  title: string;
  artists: string[]; // artist credits
  tracks: CanonicalTrack[];
  year?: number;
  country?: string;
  barcode?: string;
  catalogNumber?: string;
  media?: string;
  status?: string; // e.g., "Official"
  label?: string;
  source: 'musicbrainz' | 'discogs';
  sourceId?: string; // Discogs master ID or release ID
}

/**
 * Candidate release for matching.
 */
export interface ReleaseCandidate {
  release: CanonicalRelease;
  distance: number;
  breakdown: DistanceBreakdown;
  source: 'musicbrainz' | 'discogs' | 'embedded';
  recommendation: 'strong' | 'medium' | 'weak';
}

/**
 * Detailed breakdown of matching distance by component.
 */
export interface DistanceBreakdown {
  albumId?: number;
  trackId?: number;
  artist?: number;
  album?: number;
  trackTitle?: number;
  dataSource?: number;
  tracks?: number;
  trackArtist?: number;
  trackLength?: number;
  media?: number;
  mediums?: number;
  year?: number;
  mediumIndex?: number;
  missingTracks?: number;
  unmatchedTracks?: number;
  country?: number;
  label?: number;
  catalogNum?: number;
  albumDisambig?: number;
}

/**
 * Track alignment result.
 */
export interface TrackAlignment {
  localIndex: number;
  canonicalIndex: number | null;
  distance: number;
  title: { local: string; canonical?: string };
  duration: { local: number; canonical?: number };
}

/**
 * Default matching weights (Appendix B).
 */
export const DEFAULT_WEIGHTS = {
  albumId: 5.0,
  trackId: 5.0,
  artist: 3.0,
  album: 3.0,
  trackTitle: 3.0,
  dataSource: 2.0,
  tracks: 2.0,
  trackArtist: 2.0,
  trackLength: 2.0,
  media: 1.0,
  mediums: 1.0,
  year: 1.0,
  mediumIndex: 1.0,
  missingTracks: 0.9,
  unmatchedTracks: 0.6,
  country: 0.5,
  label: 0.5,
  catalogNum: 0.5,
  albumDisambig: 0.5,
};

/**
 * Matching preferences per library (from Appendix B).
 */
export interface MatchingPreferences {
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
  countries?: string[]; // preferred release countries
  media?: string[]; // preferred media types
  originalYear?: boolean; // prefer originaldate over date
  ignoreDataTracks?: boolean;
  ignoreVideoTracks?: boolean;
  preferredDataSource?: 'musicbrainz' | 'discogs';
}

/**
 * Thresholds from spec IDN-3.
 */
export const MATCHING_THRESHOLDS = {
  strong: 0.04, // auto-accept
  medium: 0.25, // review queue
  weak: Infinity, // unidentified
  recGapThresh: 0.25, // demote when second-best is close
};
