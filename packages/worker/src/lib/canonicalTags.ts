/**
 * The scanner stores audio_files.tags_raw as music-metadata's snapshot
 * ({ common, native }); the tag engine and the lint rules speak canonical
 * field names (tracknumber, musicbrainz_recordingid, ...). This is the one
 * place that maps between the two.
 */
import type { CanonicalField } from '@liner/shared';
import type { RawTrackTags } from '@liner/core';

export type CanonicalValue = string | string[] | null;

/**
 * The file's current tags as canonical fields, from music-metadata's
 * `common` block (what scan.parse stored in tags_raw).
 */
export function currentFieldsFrom(tagsRaw: unknown): Partial<Record<CanonicalField, CanonicalValue>> {
  const root = (typeof tagsRaw === 'string' ? JSON.parse(tagsRaw) : tagsRaw) as { common?: Record<string, unknown> } | null;
  const c = root?.common ?? {};
  const str = (k: string): string | null => {
    const v = c[k];
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : null;
    if (Array.isArray(v) && v.length && (typeof v[0] === 'string' || typeof v[0] === 'number')) return String(v[0]).trim() || null;
    return null;
  };
  const arr = (k: string): string[] | null => {
    const v = c[k];
    if (Array.isArray(v)) {
      const out = v.map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '')).filter(Boolean);
      return out.length ? out : null;
    }
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return null;
  };
  const no = (k: string, part: 'no' | 'of'): string | null => {
    const v = c[k] as { no?: unknown; of?: unknown } | undefined;
    const n = v?.[part];
    return typeof n === 'number' && n > 0 ? String(n) : typeof n === 'string' && n.trim() ? n.trim() : null;
  };
  const yearOf = (): string | null => (typeof c['year'] === 'number' && c['year'] > 0 ? String(c['year']) : null);

  const out: Partial<Record<CanonicalField, CanonicalValue>> = {
    title: str('title'),
    artist: str('artist'),
    artistsort: str('artistsort'),
    album: str('album'),
    albumartist: str('albumartist'),
    albumartistsort: str('albumartistsort'),
    date: str('date') ?? yearOf(),
    originaldate: str('originaldate') ?? str('originalyear'),
    tracknumber: no('track', 'no'),
    totaltracks: no('track', 'of'),
    discnumber: no('disk', 'no'),
    totaldiscs: no('disk', 'of'),
    discsubtitle: str('discsubtitle'),
    genre: arr('genre'),
    compilation: c['compilation'] === true || c['compilation'] === 1 || c['compilation'] === '1' ? '1' : null,
    label: arr('label') ? arr('label')!.join('; ') : null,
    catalognumber: arr('catalognumber') ? arr('catalognumber')!.join('; ') : null,
    barcode: str('barcode'),
    media: str('media'),
    releasecountry: str('releasecountry'),
    releasestatus: str('releasestatus'),
    releasetype: arr('releasetype') ? arr('releasetype')!.join('; ') : null,
    isrc: arr('isrc'),
    musicbrainz_albumid: str('musicbrainz_albumid'),
    musicbrainz_releasegroupid: str('musicbrainz_releasegroupid'),
    musicbrainz_albumartistid: arr('musicbrainz_albumartistid'),
    musicbrainz_artistid: arr('musicbrainz_artistid'),
    musicbrainz_recordingid: str('musicbrainz_recordingid'),
    musicbrainz_releasetrackid: str('musicbrainz_trackid'),
    acoustid_id: str('acoustid_id'),
    discogs_release_id: str('discogs_release_id'),
    discogs_master_id: str('discogs_master_release_id'),
  };
  return out;
}

/**
 * Lint input for a set of tracks: canonical fields, nulls dropped. Feeding
 * tags_raw straight into lintAlbum made "tracknumber" look empty on every
 * album (music-metadata keeps it under track.no), which flagged the whole
 * library for empty required fields and track-number issues.
 */
export function rawTracksForLint(tagsRaws: unknown[]): RawTrackTags[] {
  return tagsRaws.map((raw) => {
    const fields = currentFieldsFrom(raw);
    const out: RawTrackTags = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  });
}
