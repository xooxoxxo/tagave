/**
 * Which album in the library is this physical record? One-click suggestions
 * for an unmapped collection item: the owner sees "This is <album> by
 * <artist> (2012, 11 tracks) — Link" instead of a paste-an-ID box.
 *
 * Pure scoring over candidates the API has already narrowed by artist or
 * title; the weights favour the title, then the artist, with the year and
 * the track count only breaking ties.
 */
import { stringDistance } from '../text/normalize.js';

export interface PhysicalRecordInfo {
  title?: string | null | undefined;
  artists?: string[] | null | undefined;
  year?: number | null | undefined;
  trackCount?: number | null | undefined;
}

export interface LibraryAlbumCandidate {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number | null;
}

export interface RankedSuggestion<C extends LibraryAlbumCandidate = LibraryAlbumCandidate> {
  album: C;
  score: number;
}

/** Discogs names disambiguate with " (2)" and mark name variations with "*". */
export function discogsArtistName(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, '').replace(/\*+$/, '').trim();
}

/** Edition noise that says nothing about which album it is. */
const EDITION_NOISE = /[([](?:[^)\]]*\b(?:remaster(?:ed)?|deluxe|expanded|edition|reissue|anniversary|bonus|mono|stereo)\b[^)\]]*)[)\]]/gi;

/** "Yellow [DISC 1]", "Green (CD2)", "Purple - Disc 2": a folder per disc. */
const DISC_NOISE = /\s*(?:[([]\s*)?(?:disc|disk|cd)\s*\d+\s*(?:[)\]])?\s*$/i;

export function matchTitle(title: string): string {
  return title.replace(EDITION_NOISE, ' ').replace(DISC_NOISE, '').replace(/[-–—]\s*$/, '').replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
}

/** A double album's halves: "Yellow & Green" → ["yellow", "green"]. */
function titleParts(title: string): string[] {
  return title.toLowerCase().split(/\s+(?:and|\/)\s+|\s*[,/]\s*/).map((t) => t.trim()).filter((t) => t.length > 1);
}

function similarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  return 1 - stringDistance(a, b);
}

/** 0..1: how likely it is that `album` is this record. */
export function scoreSuggestion(record: PhysicalRecordInfo, album: LibraryAlbumCandidate): number {
  const recordTitle = record.title ? matchTitle(record.title) : null;
  const albumTitle = album.title ? matchTitle(album.title) : null;
  let titleSim = similarity(recordTitle, albumTitle);
  // one disc of a double album filed as its own folder ("Yellow [DISC 1]")
  if (recordTitle && albumTitle && titleParts(recordTitle).length > 1 && titleParts(recordTitle).includes(albumTitle.toLowerCase())) {
    titleSim = Math.max(titleSim, 0.8);
  }
  const artists = (record.artists ?? []).map(discogsArtistName).filter(Boolean);
  const artistSim = artists.length
    ? Math.max(
        similarity(artists.join(' & ').replace(/&/g, ' and '), album.artist?.replace(/&/g, ' and ')),
        ...artists.map((a) => similarity(a, album.artist)),
      )
    : 0;
  let score = titleSim * 0.6 + artistSim * 0.3;
  if (record.year && album.year) {
    const d = Math.abs(record.year - album.year);
    score += d === 0 ? 0.07 : d === 1 ? 0.04 : 0;
  }
  if (record.trackCount && album.trackCount && record.trackCount === album.trackCount) score += 0.03;
  // a strong artist match with an unrelated title is another album by them
  if (titleSim < 0.5) score = Math.min(score, 0.45);
  // and the same title by an unrelated artist is someone else's album
  // ("Leviathan" by Mastodon is not "Leviathan" by Annot Rhul); a
  // compilation's "Various" and an album without an artist tag say nothing
  const various = artists.length > 0 && artists.every((a) => /^various( artists)?$/i.test(a));
  if (artists.length && album.artist && !various && artistSim < 0.5) score = Math.min(score, 0.45);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

/** The best few candidates above `minScore`, best first. */
export function rankPhysicalSuggestions<C extends LibraryAlbumCandidate>(
  record: PhysicalRecordInfo,
  candidates: C[],
  { limit = 3, minScore = 0.5 }: { limit?: number; minScore?: number } = {},
): Array<RankedSuggestion<C>> {
  return candidates
    .map((album) => ({ album, score: scoreSuggestion(record, album) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || (a.album.title ?? '').localeCompare(b.album.title ?? ''))
    .slice(0, limit);
}
