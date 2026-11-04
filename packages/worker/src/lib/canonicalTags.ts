/**
 * The scanner stores files.tags_raw as music-metadata's snapshot
 * ({ common, native }); the tag engine and the lint rules speak canonical
 * field names (tracknumber, musicbrainz_recordingid, ...). This is the one
 * place that maps between the two.
 */
import type { RawTrackTags } from '@tagave/core';

export { currentFieldsFrom, type CanonicalValue } from '@tagave/core';
import { currentFieldsFrom } from '@tagave/core';

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
