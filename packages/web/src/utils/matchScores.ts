/**
 * Plain names and a fixed reading order for the matcher's distance breakdown
 * keys (core/matching DistanceBreakdown). The review table shows one dot per
 * key; the order never depends on which keys a given album happens to carry,
 * so a dot means the same thing in the same place on every album.
 */
const SCORE_KEYS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['album', 'Album'],
  ['artist', 'Artist'],
  ['trackTitle', 'Track titles'],
  ['tracks', 'Track count'],
  ['unmatchedTracks', 'Unmatched tracks'],
  ['missingTracks', 'Missing tracks'],
  ['trackLength', 'Track lengths'],
  ['trackArtist', 'Track artists'],
  ['year', 'Year'],
  ['country', 'Country'],
  ['label', 'Label'],
  ['catalogNum', 'Catalogue number'],
  ['media', 'Media'],
  ['mediums', 'Disc count'],
  ['mediumIndex', 'Disc order'],
  ['albumDisambig', 'Edition note'],
  ['albumId', 'Release ID'],
  ['trackId', 'Recording IDs'],
  ['dataSource', 'Source'],
];

const LABELS = new Map(SCORE_KEYS);
const ORDER = new Map(SCORE_KEYS.map(([k], i) => [k, i]));

/** Human label for a breakdown key; unknown keys are split out of camelCase. */
export function scoreLabel(key: string): string {
  const known = LABELS.get(key);
  if (known) return known;
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Known keys in their fixed order first, then any unknown ones alphabetically. */
export function orderScoreKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => {
    const ia = ORDER.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = ORDER.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib || a.localeCompare(b);
  });
}

/**
 * The most scored keys one album's candidates carry between them, so the most
 * dots the review table's Match column has to show without clipping.
 * Measured on the live library (2026-09): 4 to 7 for almost every album, 8 for
 * 144, 9 for one. The column is sized for this; any more wrap to a second line.
 */
export const MAX_SCORE_DOTS = 9;
