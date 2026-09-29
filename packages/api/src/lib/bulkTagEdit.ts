/**
 * Manual bulk tag edit: what the files in a selection say today, and what the
 * editor should offer as the album-level values for all of them.
 *
 * The suggestions are only a starting point the owner confirms; nothing here
 * writes. The plan they create (policy.preset 'manual') is previewed,
 * journalled and revertible like any other.
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { audioFiles, localAlbums, localTracks } from '@liner/db';
import {
  VARIOUS_ARTISTS, isVariousArtists, leadingNumberOf, stripTrackNumberPrefix,
  type ManualTagValues, type TagPlanScope,
} from '@liner/shared';
import type { getDb } from '../db.js';

type Db = ReturnType<typeof getDb>;

/** The tags of one file that the album-level editor cares about. */
export interface BulkFileTags {
  albumartist: string | null;
  album: string | null;
  artist: string | null;
  date: string | null;
  genre: string[];
  compilation: boolean;
  trackNo: number | null;
}

export interface ValueCount { value: string; files: number }

export interface BulkTagSuggestion {
  files: number;
  albums: number;
  /** what the files carry now, most common first (top 8 per field) */
  current: {
    albumartist: ValueCount[];
    album: ValueCount[];
    artist: ValueCount[];
    date: ValueCount[];
    genre: ValueCount[];
    compilation: { yes: number; no: number };
  };
  /** how many distinct values each field has (current lists only show the top 8) */
  distinct: { albumartist: number; album: number; artist: number; date: number; genre: number };
  /** the files' album artists carry their track number ("02. Name") */
  numberedAlbumArtists: number;
  /** more than one distinct track artist */
  trackArtistsDiffer: boolean;
  /** the values the editor starts from; a field is absent when nothing sensible can be said */
  suggested: ManualTagValues;
  /** other album artists worth one click */
  albumArtistOptions: string[];
  /** why the suggestion looks the way it does, one short line each */
  notes: string[];
  /**
   * true when the selection reads as one album (one album, or files that
   * agree on the title): the editor may start with the album-level
   * suggestion ticked. Otherwise it is offered, never pre-applied.
   */
  confident: boolean;
}

const counts = (values: Array<string | null | undefined>): ValueCount[] => {
  const m = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (t) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, files]) => ({ value, files })).sort((a, b) => b.files - a.files || a.value.localeCompare(b.value));
};

/** "Hotel Costes Vol. 11" from files that mostly say so; a title every file shares wins outright. */
export function suggestBulkValues(files: BulkFileTags[], albums: number): BulkTagSuggestion {
  const notes: string[] = [];
  const numbered = files.filter((f) => f.albumartist && leadingNumberOf(f.albumartist) !== null
    && (f.trackNo === null || leadingNumberOf(f.albumartist) === f.trackNo)).length;
  // Album artists with a baked-in track number stripped; VA spellings folded.
  const cleanAlbumArtists = files.map((f) => {
    if (!f.albumartist) return null;
    const stripped = stripTrackNumberPrefix(f.albumartist, f.trackNo ?? leadingNumberOf(f.albumartist));
    return isVariousArtists(stripped) ? VARIOUS_ARTISTS : stripped;
  });
  const albumArtistCounts = counts(cleanAlbumArtists);
  const artistCounts = counts(files.map((f) => f.artist));
  const trackArtistsDiffer = artistCounts.length > 1;

  const suggested: ManualTagValues = {};
  const options = new Set<string>();

  if (albumArtistCounts.length === 1) {
    suggested.albumartist = albumArtistCounts[0]!.value;
    if (numbered > 0) notes.push(`${numbered} file${numbered === 1 ? '' : 's'} carry the track number in the album artist; the suggestion drops it.`);
  } else if (trackArtistsDiffer || albumArtistCounts.length > 1) {
    suggested.albumartist = VARIOUS_ARTISTS;
  } else if (artistCounts.length === 1) {
    suggested.albumartist = artistCounts[0]!.value;
  }
  if (trackArtistsDiffer) options.add(VARIOUS_ARTISTS);
  for (const a of albumArtistCounts.slice(0, 3)) options.add(a.value);
  if (!trackArtistsDiffer && artistCounts[0]) options.add(artistCounts[0].value);
  if (suggested.albumartist) options.delete(suggested.albumartist);

  const albumCounts = counts(files.map((f) => f.album));
  if (albumCounts[0]) {
    suggested.album = albumCounts[0].value;
    if (albumCounts.length > 1) notes.push(`The files name ${albumCounts.length} different album titles; the most common is suggested.`);
  }

  // A date is only suggested when the files agree on its year.
  const dateCounts = counts(files.map((f) => f.date));
  const years = new Set(dateCounts.map((d) => d.value.slice(0, 4)));
  if (dateCounts[0] && years.size === 1) {
    // the fullest spelling of the agreed year ("2004-01-01" over "2004")
    suggested.date = [...dateCounts].sort((a, b) => b.files - a.files || b.value.length - a.value.length)[0]!.value;
  }

  if (trackArtistsDiffer) {
    suggested.compilation = '1';
    notes.push(`${artistCounts.length} different track artists: marked as a compilation, per-track artists stay as they are.`);
  }

  // Genre: the set most files share, only when one set is a clear majority.
  const genreSets = counts(files.map((f) => (f.genre.length ? [...new Set(f.genre)].sort().join('\u0000') : null)));
  if (genreSets[0] && genreSets[0].files * 2 > files.length) suggested.genre = genreSets[0].value.split('\u0000');

  const confident = albums <= 1 || albumCounts.length <= 1;
  if (albums > 1) {
    notes.push(confident
      ? `${albums} albums share this title; album-level values apply to every file in all of them.`
      : `${albums} albums with ${albumCounts.length} different titles are selected; nothing is ticked for you. Use the suggestion only if they really are one album.`);
  }

  const compYes = files.filter((f) => f.compilation).length;
  const rawAlbumArtists = counts(files.map((f) => f.albumartist));
  const genreCounts = counts(files.flatMap((f) => f.genre));
  return {
    files: files.length,
    albums,
    current: {
      albumartist: rawAlbumArtists.slice(0, 8),
      album: albumCounts.slice(0, 8),
      artist: artistCounts.slice(0, 8),
      date: dateCounts.slice(0, 8),
      genre: genreCounts.slice(0, 8),
      compilation: { yes: compYes, no: files.length - compYes },
    },
    distinct: {
      albumartist: rawAlbumArtists.length,
      album: albumCounts.length,
      artist: artistCounts.length,
      date: dateCounts.length,
      genre: genreCounts.length,
    },
    numberedAlbumArtists: numbered,
    trackArtistsDiffer,
    suggested,
    albumArtistOptions: [...options].slice(0, 4),
    notes,
    confident,
  };
}

/** music-metadata's `common` block → the fields above */
export function bulkTagsFrom(tagsRaw: unknown, trackNo: number | null): BulkFileTags {
  const root = (typeof tagsRaw === 'string' ? JSON.parse(tagsRaw) : tagsRaw) as { common?: Record<string, unknown> } | null;
  const c = root?.common ?? {};
  const str = (k: string): string | null => {
    const v = c[k];
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim() || null;
    return null;
  };
  const genre = Array.isArray(c['genre'])
    ? (c['genre'] as unknown[]).filter((g): g is string => typeof g === 'string' && !!g.trim()).map((g) => g.trim())
    : typeof c['genre'] === 'string' && c['genre'].trim() ? [c['genre'].trim()] : [];
  const tagTrack = (c['track'] as { no?: unknown } | undefined)?.no;
  return {
    albumartist: str('albumartist'),
    album: str('album'),
    artist: str('artist'),
    date: str('date') ?? (typeof c['year'] === 'number' && c['year'] > 0 ? String(c['year']) : null),
    genre,
    compilation: c['compilation'] === true || c['compilation'] === 1 || c['compilation'] === '1',
    trackNo: typeof tagTrack === 'number' && tagTrack > 0 ? tagTrack : trackNo,
  };
}

const likeEscape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Albums with at least one present file in `dirPath` or below it. */
export async function albumIdsInFolder(db: Db, libraryId: string, dirPath: string, scanRootId?: string): Promise<string[]> {
  const dir = dirPath.replace(/\/+$/, '');
  const rows = await db
    .selectDistinct({ id: localTracks.localAlbumId })
    .from(localTracks)
    .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
    .where(and(
      eq(audioFiles.libraryId, libraryId),
      eq(audioFiles.status, 'present'),
      scanRootId ? eq(audioFiles.scanRootId, scanRootId) : undefined,
      like(audioFiles.relPath, `${likeEscape(dir)}/%`),
      sql`${localTracks.localAlbumId} is not null`,
    ));
  return rows.map((r) => r.id).filter((id): id is string => !!id);
}

/**
 * Tags of every present file in `dirPath` or below it (loose files too), and
 * how many albums they belong to. A folder edit covers exactly these files.
 */
export async function filesInFolder(
  db: Db, libraryId: string, dirPath: string, scanRootId?: string,
): Promise<{ files: BulkFileTags[]; albumIds: string[] }> {
  const dir = dirPath.replace(/\/+$/, '');
  const rows = await db
    .select({ audioFileId: audioFiles.id, tagsRaw: audioFiles.tagsRaw, trackNo: localTracks.trackNo, albumId: localTracks.localAlbumId })
    .from(audioFiles)
    .leftJoin(localTracks, eq(localTracks.audioFileId, audioFiles.id))
    .where(and(
      eq(audioFiles.libraryId, libraryId),
      eq(audioFiles.status, 'present'),
      scanRootId ? eq(audioFiles.scanRootId, scanRootId) : undefined,
      like(audioFiles.relPath, `${likeEscape(dir)}/%`),
    ));
  const seen = new Set<string>();
  const albumIds = new Set<string>();
  const files: BulkFileTags[] = [];
  for (const r of rows) {
    if (r.albumId) albumIds.add(r.albumId);
    if (seen.has(r.audioFileId)) continue;
    seen.add(r.audioFileId);
    files.push(bulkTagsFrom(r.tagsRaw, r.trackNo ?? null));
  }
  return { files, albumIds: [...albumIds] };
}

/** The album ids a scope names, checked against the library; library/artist scopes are not bulk-editable. */
export async function resolveEditableScope(db: Db, libraryId: string, scope: TagPlanScope): Promise<string[]> {
  let ids: string[];
  if (scope.type === 'albumIds') ids = [...new Set(scope.albumIds)];
  else if (scope.type === 'folder') ids = await albumIdsInFolder(db, libraryId, scope.dirPath, scope.scanRootId);
  else return [];
  if (ids.length === 0) return [];
  const known = await db.select({ id: localAlbums.id }).from(localAlbums)
    .where(and(eq(localAlbums.libraryId, libraryId), inArray(localAlbums.id, ids)));
  return known.map((k) => k.id);
}

/** Tags of every present file in the albums, for suggestBulkValues. */
export async function filesOfAlbums(db: Db, albumIds: string[]): Promise<BulkFileTags[]> {
  if (albumIds.length === 0) return [];
  const rows = await db
    .select({ audioFileId: localTracks.audioFileId, trackNo: localTracks.trackNo, tagsRaw: audioFiles.tagsRaw })
    .from(localTracks)
    .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
    .where(and(inArray(localTracks.localAlbumId, albumIds), eq(audioFiles.status, 'present')));
  const seen = new Set<string>();
  const out: BulkFileTags[] = [];
  for (const r of rows) {
    if (seen.has(r.audioFileId)) continue; // a cue image has one row per track
    seen.add(r.audioFileId);
    out.push(bulkTagsFrom(r.tagsRaw, r.trackNo));
  }
  return out;
}
