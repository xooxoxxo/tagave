import { z } from 'zod';

/**
 * Canonical field names per Spec Appendix A.
 * These fields are format-independent and mapped to provider-specific tag names.
 */
export const CanonicalField = {
  // Basic metadata
  title: 'title',
  artist: 'artist',
  artistsort: 'artistsort',
  album: 'album',
  albumartist: 'albumartist',
  albumartistsort: 'albumartistsort',

  // Dates
  date: 'date',
  originaldate: 'originaldate',

  // Track and disc positioning
  tracknumber: 'tracknumber',
  totaltracks: 'totaltracks',
  discnumber: 'discnumber',
  totaldiscs: 'totaldiscs',
  discsubtitle: 'discsubtitle',

  // Classification
  genre: 'genre',
  compilation: 'compilation',

  // Release metadata
  label: 'label',
  catalognumber: 'catalognumber',
  barcode: 'barcode',
  media: 'media',
  releasecountry: 'releasecountry',
  releasestatus: 'releasestatus',
  releasetype: 'releasetype',

  // Recording identifiers
  isrc: 'isrc',
  musicbrainz_albumid: 'musicbrainz_albumid',
  musicbrainz_releasegroupid: 'musicbrainz_releasegroupid',
  musicbrainz_albumartistid: 'musicbrainz_albumartistid',
  musicbrainz_artistid: 'musicbrainz_artistid',
  musicbrainz_recordingid: 'musicbrainz_recordingid',
  musicbrainz_releasetrackid: 'musicbrainz_releasetrackid',

  // External identifiers
  acoustid_id: 'acoustid_id',
  discogs_release_id: 'discogs_release_id',
  discogs_master_id: 'discogs_master_id',
} as const;

export type CanonicalField = typeof CanonicalField[keyof typeof CanonicalField];

export const canonicalFieldSchema = z.enum([
  'title',
  'artist',
  'artistsort',
  'album',
  'albumartist',
  'albumartistsort',
  'date',
  'originaldate',
  'tracknumber',
  'totaltracks',
  'discnumber',
  'totaldiscs',
  'discsubtitle',
  'genre',
  'compilation',
  'label',
  'catalognumber',
  'barcode',
  'media',
  'releasecountry',
  'releasestatus',
  'releasetype',
  'isrc',
  'musicbrainz_albumid',
  'musicbrainz_releasegroupid',
  'musicbrainz_albumartistid',
  'musicbrainz_artistid',
  'musicbrainz_recordingid',
  'musicbrainz_releasetrackid',
  'acoustid_id',
  'discogs_release_id',
  'discogs_master_id',
]);

/**
 * A set of tags with values as strings (which may be repeated as arrays).
 */
export type TagSet = Record<CanonicalField | string, string | string[] | undefined>;

export const tagSetSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional());
