import { z } from 'zod';

/**
 * Album identification state per spec Section 11.1
 * Stored in `local_albums.state`
 */
export const albumStateSchema = z.enum([
  'pending',
  'needs_review',
  'unidentified',
  'matched',
  'as_is',
  'ignored',
]).describe('Album identification state');

export type AlbumState = z.infer<typeof albumStateSchema>;

/**
 * Format breakdown for an album (e.g., { 'flac': 12, 'mp3': 3 })
 */
export const formatBreakdownSchema = z.record(
  z.string(),
  z.number().int().nonnegative()
).describe('Audio format breakdown by count');

export type FormatBreakdown = z.infer<typeof formatBreakdownSchema>;

/**
 * Quality flags per spec Section 9.6 (GAP-5)
 * Can be stored as a JSON array in the database
 */
export const qualityFlagSchema = z.enum([
  'lossy_copy_when_lossless_exists',
  'bitrate_too_low',
  'missing_cover_art',
  'parse_error',
  'truncated_file',
  'mixed_formats',
  'inconsistent_tags',
]);

export type QualityFlag = z.infer<typeof qualityFlagSchema>;

/**
 * AlbumSummary — minimal album info for grid/list views
 * Per spec Section 9.4 (BRW-1)
 */
export const albumSummarySchema = z.object({
  id: z.string().uuid().describe('Album ID (UUIDv7)'),
  libraryId: z.string().uuid().describe('Library ID'),
  localAlbumId: z.string().uuid().describe('Local album ID from clustering'),
  title: z.string().describe('Album title'),
  artistCredit: z.string().describe('Artist credit string'),
  year: z.number().int().min(1000).max(2100).optional().describe('Release year'),
  formats: z.array(z.string()).describe('Audio formats in this album (e.g., ["flac", "mp3"])'),
  formatBreakdown: formatBreakdownSchema.optional().describe('Count per format'),
  isLossless: z.boolean().optional().describe('True if all tracks are lossless'),
  isMixed: z.boolean().optional().describe('True if mixed lossless/lossy'),
  state: albumStateSchema.describe('Identification state'),
  trackCount: z.number().int().nonnegative().describe('Number of local files'),
  canonicalTrackCount: z.number().int().nonnegative().optional().describe('Tracks on the matched release'),
  coverUrl: z.string().url().nullable().optional().describe('Cover art URL (300px thumbnail)'),
  hasReview: z.boolean().optional().describe('Owner has written a review'),
  isPhysicallyOwned: z.boolean().optional().describe('In the Discogs collection'),
  isDuplicate: z.boolean().optional().describe('Another local album matched to the same release group'),
  qualityFlags: z.array(qualityFlagSchema).optional().describe('Lint/quality issues'),
  matchId: z.string().uuid().optional().describe('Album match ID'),
  releaseId: z.string().uuid().optional().describe('Matched release ID'),
  releaseGroupId: z.string().uuid().optional().describe('Matched release group ID'),
  createdAt: z.string().datetime().describe('When added to the library'),
  updatedAt: z.string().datetime().describe('Last metadata update'),
}).strict();

export type AlbumSummary = z.infer<typeof albumSummarySchema>;

/**
 * Match info for an album
 */
export const matchInfoSchema = z.object({
  releaseId: z.string().uuid(),
  releaseGroupId: z.string().uuid(),
  title: z.string(),
  artistCredit: z.string(),
  year: z.number().int().optional(),
  status: z.enum(['auto', 'confirmed', 'rejected']).describe('How this match was decided'),
  decidedBy: z.enum(['system', 'user']).describe('Who/what made the decision'),
  distance: z.number().min(0).max(1).describe('Match distance (0 = perfect)'),
  reason: z.string().optional().describe('User reason for rejection or decision'),
}).strict();

export type MatchInfo = z.infer<typeof matchInfoSchema>;

/**
 * Local track info for the Files tab
 */
export const localTrackSchema = z.object({
  id: z.string().uuid(),
  audioFileId: z.string().uuid(),
  discNo: z.number().int().positive().optional(),
  trackNo: z.number().int().positive().describe('Track number as read from tags'),
  titleGuess: z.string().describe('Track title from tags'),
  artistGuess: z.string().optional().describe('Track artist (if different from album artist)'),
  durationMs: z.number().int().positive(),
  recordingId: z.string().uuid().optional().describe('MusicBrainz recording ID'),
  canonicalTrackId: z.string().uuid().optional().describe('Reference to canonical_tracks'),
}).strict();

export type LocalTrack = z.infer<typeof localTrackSchema>;

/**
 * Local file info
 */
export const localFileSchema = z.object({
  id: z.string().uuid(),
  relativePath: z.string().describe('Path relative to scan root'),
  container: z.string().describe('Audio container (flac, mp3, m4a, etc.)'),
  codec: z.string().describe('Audio codec (FLAC, AAC, ALAC, etc.)'),
  lossless: z.boolean(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive().optional(),
  bitDepth: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitrate: z.number().int().positive().optional().describe('Average bitrate in kbps'),
  hasEmbeddedArt: z.boolean(),
  status: z.enum(['present', 'missing', 'archived', 'error']).describe('File presence status'),
  parseError: z.string().optional().describe('Error message if status = error'),
  tagsRaw: z.record(z.union([z.string(), z.array(z.string())])).optional().describe('Raw tags as read'),
  trackInfo: localTrackSchema.optional(),
}).strict();

export type LocalFile = z.infer<typeof localFileSchema>;

/**
 * Canonical track from a release
 */
export const canonicalTrackSchema = z.object({
  id: z.string().uuid(),
  mediumNo: z.number().int().positive(),
  position: z.number().int().positive(),
  number: z.string().optional().describe('Track number as printed'),
  title: z.string(),
  artistCredit: z.string(),
  recordingId: z.string().uuid(),
  lengthMs: z.number().int().positive(),
  isDataTrack: z.boolean().optional(),
  isVideo: z.boolean().optional(),
}).strict();

export type CanonicalTrack = z.infer<typeof canonicalTrackSchema>;

/**
 * External link with source
 */
export const externalLinkSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  source: z.string().describe('e.g., "musicbrainz", "discogs", "wikidata"'),
}).strict();

export type ExternalLink = z.infer<typeof externalLinkSchema>;

/**
 * AlbumDetail — full album info for the album page
 * Extends AlbumSummary with enriched metadata
 */
export const albumDetailSchema = albumSummarySchema.extend({
  // Matched release details
  matchInfo: matchInfoSchema.optional(),

  // Canonical metadata
  releaseTitle: z.string().optional(),
  releaseArtistCredit: z.string().optional(),
  releaseDate: z.string().date().optional(),
  originalDate: z.string().date().optional(),
  barcode: z.string().optional(),
  label: z.string().optional(),
  catalogNumber: z.string().optional(),
  releaseCountry: z.string().optional(),
  releaseStatus: z.enum(['official', 'promotion', 'bootleg', 'pseudo-release', 'withdrawn', 'cancelled']).optional(),
  releaseType: z.array(z.string()).optional().describe('Album, EP, Single, etc.'),

  // Genres and tags (from canonical cache)
  genres: z.array(z.string()).optional(),
  styles: z.array(z.string()).optional(),
  tags: z.record(z.number()).optional().describe('MusicBrainz tags with vote counts'),

  // Audio files
  files: z.array(localFileSchema).optional(),

  // Canonical tracklist
  canonicalTracks: z.array(canonicalTrackSchema).optional(),

  // Editions (other releases in the group)
  editionCount: z.number().int().nonnegative().optional(),

  // External identifiers and links
  musicbrainzId: z.string().optional(),
  releaseGroupMbid: z.string().optional(),
  discogsId: z.string().optional(),
  discogsMasterId: z.string().optional(),
  externalLinks: z.array(externalLinkSchema).optional(),

  // Ownership and collection
  physicalOwnershipState: z.enum(['owned', 'owned_only_physical', 'not_owned']).optional(),
  discogsCollectionItems: z.array(z.object({
    id: z.string(),
    folder: z.string(),
    mediaCondition: z.string().optional(),
    sleeveCondition: z.string().optional(),
    rating: z.number().int().min(0).max(5).optional(),
  })).optional(),
}).strict();

export type AlbumDetail = z.infer<typeof albumDetailSchema>;

/**
 * Album metadata diff for tag plan preview
 */
export const metadataDiffSchema = z.object({
  field: z.string().describe('Canonical field name'),
  before: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  after: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  reason: z.string().optional().describe('Why this changed'),
  isLocked: z.boolean().optional().describe('Field is owner-locked'),
}).strict();

export type MetadataDiff = z.infer<typeof metadataDiffSchema>;
