/**
 * Artist names as the library shows them.
 *
 * Two kinds of tag noise make one compilation look like many artists:
 * - a track number baked into the album artist ("02. Stephane Pompougnac"),
 *   which files every track of "Hotel Costes Vol. 11" under its own artist;
 * - the many spellings of "Various Artists" ("Various", "VA", "V.A.").
 *
 * These helpers never touch files. The SQL function liner_display_artist
 * (migration 0028) mirrors displayArtistName so list queries group the same
 * way the API presents names; keep the two in step.
 */

export const VARIOUS_ARTISTS = 'Various Artists';

const VARIOUS_SPELLINGS = new Set([
  'various', 'various artists', 'various artist', 'va', 'v.a.', 'v.a', 'v/a', 'varios', 'varios artistas', 'divers', 'artistes divers',
]);

/** true for "Various", "VA", "V/A", "Various Artists" and similar. */
export function isVariousArtists(name: string | null | undefined): boolean {
  if (!name) return false;
  return VARIOUS_SPELLINGS.has(name.normalize('NFC').trim().toLowerCase());
}

const NUMBER_PREFIX = /^(\d{1,3})\.\s+(\S.*)$/u;

/** The number of a "NN. Name" prefix, or null when the name has none. */
export function leadingNumberOf(name: string | null | undefined): number | null {
  const m = name ? NUMBER_PREFIX.exec(name.trim()) : null;
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * "02. Stephane Pompougnac" → "Stephane Pompougnac".
 *
 * With `trackNo` the prefix only comes off when it is that file's track
 * number (the ripper wrote the track number into the field), so a real name
 * that happens to start with a number stays whole. Without it the prefix
 * always comes off; use that only for display.
 */
export function stripTrackNumberPrefix(name: string, trackNo?: number | null): string {
  const m = NUMBER_PREFIX.exec(name.trim());
  if (!m) return name;
  if (trackNo !== undefined) {
    if (trackNo === null || parseInt(m[1]!, 10) !== trackNo) return name;
  }
  return m[2]!.trim();
}

/**
 * The name a list shows for an album-artist guess: numbering stripped,
 * every VA spelling folded into "Various Artists".
 */
export function displayArtistName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (isVariousArtists(trimmed)) return VARIOUS_ARTISTS;
  const stripped = stripTrackNumberPrefix(trimmed);
  return isVariousArtists(stripped) ? VARIOUS_ARTISTS : stripped;
}
