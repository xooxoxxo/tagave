/** Preserve provider spelling and order while suppressing duplicate genre labels. */
export function uniqueGenres(...sources: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  return sources.flatMap(source => source ?? []).filter(label => {
    const key = label.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(label => label.trim());
}

const artistKey = (name: string | null | undefined) => (name ?? '').trim().toLocaleLowerCase();

/**
 * Whether the track list needs its own Artist column: some track credits an
 * artist other than the album's (a compilation, a split, a guest). Tracks
 * without an artist tag of their own take the album's and do not count.
 */
export function showsTrackArtists(tracks: ReadonlyArray<{ artist?: string | null }>, albumArtist: string | null | undefined): boolean {
  const album = artistKey(albumArtist);
  return tracks.some((t) => {
    const key = artistKey(t.artist);
    return key !== '' && key !== album;
  });
}
