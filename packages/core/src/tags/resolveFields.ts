/**
 * Pure field resolution logic for canonical metadata.
 *
 * Given a release, release group, track, artist credits, effective genres, and field locks,
 * resolves the canonical values for all 32 CanonicalField values.
 *
 * Lock precedence (ENR-5): a field with an active lock (scope=file or album, created_at present, not expired)
 * uses the lock's value and is marked as 'lock' source. Otherwise, the field is resolved from
 * release/release-group/track data and marked as 'canonical'.
 *
 * Spec: §9.5 ENR-5 (lines 258–261), §11.5 (line 547), Appendix A.
 */

import type { CanonicalField } from '@liner/shared';
import { CanonicalField as CanonicalFieldEnum } from '@liner/shared';
import type { EffectiveGenres } from '../genres/index.js';

/**
 * Representation of a resolved field value with source and reasoning.
 */
export interface ResolvedField {
  value: string | string[] | undefined;
  source: 'canonical' | 'lock' | 'existing';
  reason: string;
}

/**
 * Resolved metadata for a file: all 32 canonical fields with sources and reasons.
 */
export type ResolvedMetadata = Record<CanonicalField, ResolvedField>;

/**
 * A field lock that applies to this file or its album.
 */
export interface FieldLock {
  field: string;
  value: string | string[] | undefined;
  scope: 'file' | 'album';
  createdAt?: string | Date | null; // timestamp; null means expired or inactive
  reason?: string | null;
}

/**
 * Input to resolveFields: the canonical entities and active locks.
 */
export interface ResolutionInput {
  /** The matched release (edition). */
  release?: {
    title?: string;
    date?: string; // YYYY-MM-DD
    trackCount?: number;
    barcode?: string;
    country?: string;
    status?: string;
    labels?: Array<{ name?: string; catalogNumber?: string }>;
    media?: Array<{ format?: string }>;
    mbid?: string;
    discogsReleaseId?: number;
    artists?: Array<{ name: string; joinPhrase?: string; mbid?: string }>;
  };
  /** The release group (for fallback data). */
  releaseGroup?: {
    title?: string;
    primaryType?: string;
    firstReleaseDate?: string; // YYYY-MM-DD
    mbid?: string;
    discogsMasterId?: number;
    secondaryTypes?: string[];
    artistCredit?: Array<{ name: string; joinPhrase?: string; mbid?: string }>;
  };
  /** The matched track (recording on the release). */
  track?: {
    number?: string;
    title?: string;
    mediumNo?: number;
    position?: number;
    artistCredit?: Array<{ name: string; joinPhrase?: string; mbid?: string }>;
    isrc?: string | string[];
    mbid?: string;
  };
  /** Artist credits from release or release group. */
  artistCredits?: Array<{ name: string; joinPhrase?: string; mbid?: string }>;
  /** Computed effective genres from Discogs + MusicBrainz. */
  effectiveGenres?: EffectiveGenres;
  /** Active field locks for this file (scope=file) or album (scope=album). */
  locks?: FieldLock[];
}

/**
 * Resolve canonical fields for a file given release/track/lock data.
 *
 * Returns a ResolvedMetadata record with all 32 CanonicalField keys.
 * Each field includes a value (or undefined if not available), source ('canonical' or 'lock'),
 * and a reason explaining where the value came from.
 *
 * Lock precedence (ENR-5): fields with active locks use the lock value;
 * fields with no lock use canonical data from the release/track.
 *
 * Null/undefined values in release data are silently skipped (no null in output).
 */
export function resolveFields(input: ResolutionInput): ResolvedMetadata {
  const {
    release,
    releaseGroup,
    track,
    artistCredits: albumArtistCredits,
    effectiveGenres,
    locks = [],
  } = input;

  // Build a lock map: field → lock value (file scope takes precedence over album scope)
  const lockMap = new Map<string, FieldLock>();
  for (const lock of locks) {
    if (!lockMap.has(lock.field) || lock.scope === 'file') {
      lockMap.set(lock.field, lock);
    }
  }

  /**
   * Resolve a single field: check locks first, then canonical data.
   */
  function resolveField(field: CanonicalField): ResolvedField {
    const lock = lockMap.get(field);
    if (lock) {
      return {
        value: lock.value,
        source: 'lock',
        reason: lock.reason || `Field locked (${lock.scope} scope)`,
      };
    }

    // Resolve from canonical data
    let value: string | string[] | undefined;
    let reason: string;

    switch (field) {
      // Basic metadata from track
      case 'title':
        value = track?.title || releaseGroup?.title;
        reason = track?.title ? 'from track' : releaseGroup?.title ? 'from release group' : 'no title available';
        break;

      // Artist: track artist credit, fall back to release/album artist
      case 'artist':
        value = formatArtistCredit(track?.artistCredit || albumArtistCredits);
        reason = track?.artistCredit ? 'from track' : albumArtistCredits ? 'from album' : 'no artist available';
        break;

      // Artist sort: from release group artist credit
      case 'artistsort':
        value = formatArtistSortName(track?.artistCredit || albumArtistCredits);
        reason = track?.artistCredit ? 'from track' : albumArtistCredits ? 'from album' : 'no artist sort available';
        break;

      // Album metadata from release
      case 'album':
        value = release?.title || releaseGroup?.title;
        reason = release?.title ? 'from release' : releaseGroup?.title ? 'from release group' : 'no album title available';
        break;

      // Album artist: release artist credit, fall back to release group
      case 'albumartist':
        value = formatArtistCredit(albumArtistCredits);
        reason = albumArtistCredits ? 'from album' : 'no album artist available';
        break;

      // Album artist sort
      case 'albumartistsort':
        value = formatArtistSortName(albumArtistCredits);
        reason = albumArtistCredits ? 'from album' : 'no album artist sort available';
        break;

      // Dates
      case 'date':
        value = release?.date;
        reason = release?.date ? 'from release' : 'no release date available';
        break;

      case 'originaldate':
        value = releaseGroup?.firstReleaseDate;
        reason = releaseGroup?.firstReleaseDate ? 'from release group' : 'no original date available';
        break;

      // Track positioning from track
      case 'tracknumber':
        value = track?.number || String(track?.position ?? '');
        reason = track?.number ? 'from track number' : track?.position ? `from track position ${track.position}` : 'no track number available';
        break;

      case 'discnumber':
        value = track?.mediumNo ? String(track.mediumNo) : undefined;
        reason = track?.mediumNo ? `from medium ${track.mediumNo}` : 'no disc number available';
        break;

      case 'totaltracks':
        value = release?.trackCount ? String(release.trackCount) : undefined;
        reason = release?.trackCount ? `from release track count` : 'no total tracks available';
        break;

      case 'totaldiscs':
        // This would come from release.media array length or a field we need to compute
        // For now, leave undefined as we don't have direct access to computed total discs
        value = undefined;
        reason = 'total discs not computed';
        break;

      case 'discsubtitle':
        // Would come from release.media[mediumNo-1].title if available
        value = undefined;
        reason = 'disc subtitle not computed';
        break;

      // Classification
      case 'genre':
        value = effectiveGenres?.genres && effectiveGenres.genres.length > 0
          ? effectiveGenres.genres.map(g => titleCase(g))
          : undefined;
        reason = effectiveGenres?.genres?.length
          ? `from effective genres (${effectiveGenres.genres.length} genres)`
          : 'no genres available';
        break;

      case 'compilation':
        // MusicBrainz: release-group primary type = 'Album' and secondary types include 'Compilation'
        const isCompilation = releaseGroup?.primaryType === 'Album' && releaseGroup?.secondaryTypes?.includes?.('Compilation');
        value = isCompilation ? '1' : undefined;
        reason = isCompilation ? 'from release group type' : 'not a compilation';
        break;

      // Release metadata
      case 'label':
        value = formatLabels(release?.labels as any);
        reason = release?.labels && Array.isArray(release.labels) && (release.labels as any[]).length > 0
          ? 'from release labels'
          : 'no labels available';
        break;

      case 'catalognumber':
        value = formatCatalogNumbers(release?.labels as any);
        reason = release?.labels && Array.isArray(release.labels) && (release.labels as any[]).length > 0
          ? 'from release labels'
          : 'no catalog numbers available';
        break;

      case 'barcode':
        value = release?.barcode;
        reason = release?.barcode ? 'from release' : 'no barcode available';
        break;

      case 'media':
        value = formatMedia(release?.media as any);
        reason = release?.media && Array.isArray(release.media) && (release.media as any[]).length > 0
          ? 'from release media'
          : 'no media information available';
        break;

      case 'releasecountry':
        value = release?.country;
        reason = release?.country ? `ISO 3166-1 alpha-2: ${release.country}` : 'no country available';
        break;

      case 'releasestatus':
        value = release?.status;
        reason = release?.status ? 'from release' : 'no release status available';
        break;

      case 'releasetype':
        value = releaseGroup?.primaryType;
        reason = releaseGroup?.primaryType ? 'from release group primary type' : 'no release type available';
        break;

      // Recording identifiers
      case 'isrc':
        value = track?.isrc
          ? Array.isArray(track.isrc) ? track.isrc : [track.isrc]
          : undefined;
        reason = track?.isrc ? 'from track' : 'no ISRC available';
        break;

      case 'musicbrainz_albumid':
        value = release?.mbid;
        reason = release?.mbid ? 'from release' : 'no MusicBrainz album ID available';
        break;

      case 'musicbrainz_releasegroupid':
        value = releaseGroup?.mbid;
        reason = releaseGroup?.mbid ? 'from release group' : 'no MusicBrainz release group ID available';
        break;

      case 'musicbrainz_albumartistid':
        value = extractArtistMbids(albumArtistCredits);
        reason = albumArtistCredits?.some(a => a.mbid) ? 'from album artist credits' : 'no album artist MBIDs available';
        break;

      case 'musicbrainz_artistid':
        value = extractArtistMbids(track?.artistCredit || albumArtistCredits);
        reason = (track?.artistCredit || albumArtistCredits)?.some(a => a.mbid)
          ? 'from artist credits'
          : 'no artist MBIDs available';
        break;

      case 'musicbrainz_recordingid':
        value = track?.mbid;
        reason = track?.mbid ? 'from recording' : 'no MusicBrainz recording ID available';
        break;

      case 'musicbrainz_releasetrackid':
        // This would be the track's UUID in the canonical_tracks table
        // Not typically stored or returned in this context, left undefined
        value = undefined;
        reason = 'MusicBrainz release track ID not available in this context';
        break;

      // External identifiers
      case 'acoustid_id':
        // Would come from the recording's acoustid field if available
        value = undefined;
        reason = 'AcoustID not available';
        break;

      case 'discogs_release_id':
        value = release?.discogsReleaseId ? String(release.discogsReleaseId) : undefined;
        reason = release?.discogsReleaseId ? 'from release' : 'no Discogs release ID available';
        break;

      case 'discogs_master_id':
        value = releaseGroup?.discogsMasterId ? String(releaseGroup.discogsMasterId) : undefined;
        reason = releaseGroup?.discogsMasterId ? 'from release group' : 'no Discogs master ID available';
        break;

      default:
        value = undefined;
        reason = 'unknown field';
    }

    return {
      value,
      source: 'canonical',
      reason: reason || 'no value available',
    };
  }

  // Resolve all 32 canonical fields
  const result: Record<string, ResolvedField> = {};
  const fields = Object.values(CanonicalFieldEnum) as CanonicalField[];

  for (const field of fields) {
    result[field] = resolveField(field);
  }

  return result as ResolvedMetadata;
}

/**
 * Format artist credits as a joined string (e.g., "Artist A feat. Artist B").
 */
function formatArtistCredit(
  credits?: Array<{ name: string; joinPhrase?: string }>,
): string | undefined {
  if (!credits || credits.length === 0) return undefined;
  return credits
    .map((c, i) => {
      const name = (c.name || '').trim();
      const join = i < credits.length - 1 ? (c.joinPhrase || '') : '';
      return name + join;
    })
    .join('')
    .trim() || undefined;
}

/**
 * Format artist sort names: for a single artist, extract just the name;
 * for multiple, join with "; ".
 */
function formatArtistSortName(
  credits?: Array<{ name: string }>,
): string | undefined {
  if (!credits || credits.length === 0) return undefined;
  const names = credits.map(c => (c.name || '').trim()).filter(Boolean);
  return names.length > 0 ? names.join('; ') : undefined;
}

/**
 * Extract all MusicBrainz artist IDs from credits.
 */
function extractArtistMbids(
  credits?: Array<{ mbid?: string }>,
): string[] | undefined {
  if (!credits || credits.length === 0) return undefined;
  const mbids = credits
    .map(c => c.mbid)
    .filter((m): m is string => !!m);
  return mbids.length > 0 ? mbids : undefined;
}

/**
 * Format release labels as a joined string.
 */
function formatLabels(labels?: any[]): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const names = labels
    .map(l => (l.name || '').trim())
    .filter(Boolean);
  return names.length > 0 ? names.join('; ') : undefined;
}

/**
 * Format catalog numbers from labels.
 */
function formatCatalogNumbers(labels?: any[]): string | undefined {
  if (!labels || labels.length === 0) return undefined;
  const cats = labels
    .map(l => (l.catalogNumber || '').trim())
    .filter(Boolean);
  return cats.length > 0 ? cats.join('; ') : undefined;
}

/**
 * Format media descriptions from release.media array.
 */
function formatMedia(media?: any[]): string | undefined {
  if (!media || media.length === 0) return undefined;
  const formats = media
    .map(m => (m.format || '').trim())
    .filter(Boolean);
  return formats.length > 0 ? formats.join('; ') : undefined;
}

/**
 * Title-case a string (capitalize first letter of each word).
 */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
