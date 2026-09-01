/**
 * Tag mapping from canonical fields to format-specific tag names.
 * Follows spec Appendix A and MusicBrainz Picard tag mapping.
 */
import type { CanonicalField, TagSet } from '@liner/shared';

/**
 * Tag names for each format.
 */
export interface FormatTagMapping {
  id3v24?: string | string[] | undefined; // ID3v2.4
  id3v23?: string | string[] | undefined; // ID3v2.3
  vorbis?: string | string[] | undefined; // FLAC, OGG, Opus
  mp4?: string | string[] | undefined; // M4A, ALAC
  ape?: string | undefined; // APE, WavPack (read-only in v1)
  dsf?: string | undefined; // DSF (uses ID3)
  dff?: string | undefined; // DFF (uses ID3)
  wav?: string | undefined; // WAV (uses ID3)
  aiff?: string | undefined; // AIFF (uses ID3)
}

/**
 * Complete tag mapping per Appendix A.
 * Multi-valued fields are marked with ✱ in the spec.
 */
export const TAG_MAPPING: Record<CanonicalField | string, FormatTagMapping> = {
  title: {
    id3v24: 'TIT2',
    id3v23: 'TIT2',
    vorbis: 'TITLE',
    mp4: '©nam',
  },
  artist: {
    // Multi-valued field ✱
    id3v24: 'TPE1',
    id3v23: 'TPE1',
    vorbis: 'ARTIST',
    mp4: '©ART',
  },
  artistsort: {
    id3v24: 'TSOP',
    id3v23: 'TSOP',
    vorbis: 'ARTISTSORT',
    mp4: 'soar',
  },
  album: {
    id3v24: 'TALB',
    id3v23: 'TALB',
    vorbis: 'ALBUM',
    mp4: '©alb',
  },
  albumartist: {
    id3v24: 'TPE2',
    id3v23: 'TPE2',
    vorbis: 'ALBUMARTIST',
    mp4: 'aART',
  },
  albumartistsort: {
    id3v24: 'TSO2',
    id3v23: 'TSO2',
    vorbis: 'ALBUMARTISTSORT',
    mp4: 'soaa',
  },
  date: {
    // Release date
    id3v24: 'TDRC',
    id3v23: ['TYER', 'TDAT'], // Split into TYER and TDAT in v2.3
    vorbis: 'DATE',
    mp4: '©day',
  },
  originaldate: {
    id3v24: 'TDOR',
    id3v23: 'TORY',
    vorbis: 'ORIGINALDATE',
    mp4: '----:com.apple.iTunes:ORIGINALDATE', // Liner custom convention
  },
  tracknumber: {
    id3v24: 'TRCK', // n/N format
    id3v23: 'TRCK',
    vorbis: 'TRACKNUMBER',
    mp4: 'trkn',
  },
  totaltracks: {
    id3v24: 'TRCK', // Stored with TRCK as n/N
    id3v23: 'TRCK',
    vorbis: ['TRACKTOTAL', 'TOTALTRACKS'], // Both, as Picard does
    mp4: 'trkn',
  },
  discnumber: {
    id3v24: 'TPOS', // n/N format
    id3v23: 'TPOS',
    vorbis: 'DISCNUMBER',
    mp4: 'disk',
  },
  totaldiscs: {
    id3v24: 'TPOS', // Stored with TPOS as n/N
    id3v23: 'TPOS',
    vorbis: ['DISCTOTAL', 'TOTALDISCS'],
    mp4: 'disk',
  },
  discsubtitle: {
    id3v24: 'TSST', // v2.4 only
    id3v23: undefined,
    vorbis: 'DISCSUBTITLE',
    mp4: '----:com.apple.iTunes:DISCSUBTITLE',
  },
  genre: {
    // Multi-valued field ✱
    id3v24: 'TCON',
    id3v23: 'TCON',
    vorbis: 'GENRE',
    mp4: '©gen',
  },
  label: {
    id3v24: 'TPUB',
    id3v23: 'TPUB',
    vorbis: 'LABEL',
    mp4: '----:com.apple.iTunes:LABEL',
  },
  catalognumber: {
    id3v24: 'TXXX:CATALOGNUMBER',
    id3v23: 'TXXX:CATALOGNUMBER',
    vorbis: 'CATALOGNUMBER',
    mp4: '----:com.apple.iTunes:CATALOGNUMBER',
  },
  barcode: {
    id3v24: 'TXXX:BARCODE',
    id3v23: 'TXXX:BARCODE',
    vorbis: 'BARCODE',
    mp4: '----:com.apple.iTunes:BARCODE',
  },
  media: {
    id3v24: 'TMED',
    id3v23: 'TMED',
    vorbis: 'MEDIA',
    mp4: '----:com.apple.iTunes:MEDIA',
  },
  releasecountry: {
    id3v24: 'TXXX:MusicBrainz Album Release Country',
    id3v23: 'TXXX:MusicBrainz Album Release Country',
    vorbis: 'RELEASECOUNTRY',
    mp4: '----:com.apple.iTunes:MusicBrainz Album Release Country',
  },
  releasestatus: {
    id3v24: 'TXXX:MusicBrainz Album Status',
    id3v23: 'TXXX:MusicBrainz Album Status',
    vorbis: 'RELEASESTATUS',
    mp4: '----:com.apple.iTunes:MusicBrainz Album Status',
  },
  releasetype: {
    // Multi-valued field ✱
    id3v24: 'TXXX:MusicBrainz Album Type',
    id3v23: 'TXXX:MusicBrainz Album Type',
    vorbis: 'RELEASETYPE',
    mp4: '----:com.apple.iTunes:MusicBrainz Album Type',
  },
  compilation: {
    id3v24: 'TCMP',
    id3v23: 'TCMP',
    vorbis: 'COMPILATION',
    mp4: 'cpil',
  },
  isrc: {
    id3v24: 'TSRC',
    id3v23: 'TSRC',
    vorbis: 'ISRC',
    mp4: '----:com.apple.iTunes:ISRC',
  },
  musicbrainz_albumid: {
    // MusicBrainz release ID
    id3v24: 'TXXX:MusicBrainz Album Id',
    id3v23: 'TXXX:MusicBrainz Album Id',
    vorbis: 'MUSICBRAINZ_ALBUMID',
    mp4: '----:com.apple.iTunes:MusicBrainz Album Id',
  },
  musicbrainz_releasegroupid: {
    id3v24: 'TXXX:MusicBrainz Release Group Id',
    id3v23: 'TXXX:MusicBrainz Release Group Id',
    vorbis: 'MUSICBRAINZ_RELEASEGROUPID',
    mp4: '----:com.apple.iTunes:MusicBrainz Release Group Id',
  },
  musicbrainz_albumartistid: {
    // Multi-valued field ✱
    id3v24: 'TXXX:MusicBrainz Album Artist Id',
    id3v23: 'TXXX:MusicBrainz Album Artist Id',
    vorbis: 'MUSICBRAINZ_ALBUMARTISTID',
    mp4: '----:com.apple.iTunes:MusicBrainz Album Artist Id',
  },
  musicbrainz_artistid: {
    // Multi-valued field ✱
    id3v24: 'TXXX:MusicBrainz Artist Id',
    id3v23: 'TXXX:MusicBrainz Artist Id',
    vorbis: 'MUSICBRAINZ_ARTISTID',
    mp4: '----:com.apple.iTunes:MusicBrainz Artist Id',
  },
  musicbrainz_recordingid: {
    // Stored under legacy "Track Id" tag names
    id3v24: 'UFID:http://musicbrainz.org',
    id3v23: 'UFID:http://musicbrainz.org',
    vorbis: 'MUSICBRAINZ_TRACKID',
    mp4: '----:com.apple.iTunes:MusicBrainz Track Id',
  },
  musicbrainz_releasetrackid: {
    id3v24: 'TXXX:MusicBrainz Release Track Id',
    id3v23: 'TXXX:MusicBrainz Release Track Id',
    vorbis: 'MUSICBRAINZ_RELEASETRACKID',
    mp4: '----:com.apple.iTunes:MusicBrainz Release Track Id',
  },
  acoustid_id: {
    id3v24: 'TXXX:Acoustid Id',
    id3v23: 'TXXX:Acoustid Id',
    vorbis: 'ACOUSTID_ID',
    mp4: '----:com.apple.iTunes:Acoustid Id',
  },
  discogs_release_id: {
    id3v24: 'TXXX:DISCOGS_RELEASE_ID',
    id3v23: 'TXXX:DISCOGS_RELEASE_ID',
    vorbis: 'DISCOGS_RELEASE_ID',
    mp4: '----:com.apple.iTunes:DISCOGS_RELEASE_ID',
  },
  discogs_master_id: {
    id3v24: 'TXXX:DISCOGS_MASTER_ID',
    id3v23: 'TXXX:DISCOGS_MASTER_ID',
    vorbis: 'DISCOGS_MASTER_ID',
    mp4: '----:com.apple.iTunes:DISCOGS_MASTER_ID',
  },
};

/**
 * Get tag names for a specific format.
 */
export function getTagNamesForFormat(
  canonicalField: CanonicalField | string,
  format: 'id3v24' | 'id3v23' | 'vorbis' | 'mp4' | 'ape'
): string | string[] | undefined {
  const mapping = TAG_MAPPING[canonicalField];
  if (!mapping) return undefined;
  return mapping[format];
}

/**
 * Multi-valued fields that should be repeated or separated, not concatenated.
 */
export const MULTI_VALUE_FIELDS = new Set<CanonicalField>([
  'artist',
  'genre',
  'releasetype',
  'musicbrainz_albumartistid',
  'musicbrainz_artistid',
]);

/**
 * Check if a field supports multiple values.
 */
export function isMultiValueField(field: CanonicalField | string): boolean {
  return MULTI_VALUE_FIELDS.has(field as CanonicalField);
}

/**
 * Join multi-value field with separator (for ID3v2.3).
 */
export function joinMultiValue(values: string[], separator: string = '; '): string {
  return values.join(separator);
}

/**
 * Split multi-value field by separator (for ID3v2.3).
 */
export function splitMultiValue(value: string, separator: string = ';'): string[] {
  return value.split(separator).map((v) => v.trim());
}

/**
 * Export TagSet type from shared for convenience.
 */
export type { TagSet } from '@liner/shared';
