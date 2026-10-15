/**
 * Which song on the player server is which local track.
 *
 * tagave and the server read the same files under different mount points
 * (the file worker sees /mnt/music/…, the bundled Navidrome /music/…, a
 * server the owner runs anywhere), so paths are compared by their end: the
 * path relative to tagave's music root must be the tail of the server's
 * path. That pins the exact copy when a release exists twice. When the
 * server does not report real paths, the recording MBID with the disc and
 * track position decides, and last the position with a matching title and
 * length.
 */
import type { ServerSong } from './subsonic.js';

export interface LocalTrackRef {
  id: string;
  /** the file's path relative to tagave's music root (or to its scan root when that is all tagave knows) */
  relPath: string;
  recordingMbid: string | null;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  durationMs: number | null;
}

export type MatchedBy = 'path' | 'recording' | 'position';

export interface TrackMatch {
  song: ServerSong;
  matchedBy: MatchedBy;
}

/** NFC, forward slashes, no leading ./ or /, case kept (file systems differ). */
export function normalizePath(p: string): string {
  return p.normalize('NFC').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/** True when `serverPath` ends with `relPath` at a path boundary. */
export function pathTailMatches(serverPath: string, relPath: string): boolean {
  const s = normalizePath(serverPath);
  const r = normalizePath(relPath);
  if (!r) return false;
  return s === r || s.endsWith(`/${r}`);
}

const normTitle = (t: string | null | undefined) =>
  (t ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Matches local tracks against the server's songs. Each song is used once.
 * Order of evidence: path tail, then recording MBID + disc + track, then disc
 * + track + title + length within 3 s.
 */
export function matchTracks(local: readonly LocalTrackRef[], songs: readonly ServerSong[]): Map<string, TrackMatch> {
  const out = new Map<string, TrackMatch>();
  const used = new Set<string>();
  const take = (t: LocalTrackRef, song: ServerSong, matchedBy: MatchedBy) => {
    out.set(t.id, { song, matchedBy });
    used.add(song.id);
  };

  // 1. path tail (the longest relPath first, so a nested copy wins over its parent)
  for (const t of [...local].sort((a, b) => b.relPath.length - a.relPath.length)) {
    const hits = songs.filter((s) => !used.has(s.id) && s.path && pathTailMatches(s.path, t.relPath));
    if (hits.length === 1) take(t, hits[0]!, 'path');
  }

  const disc = (n: number | null | undefined) => (n && n > 0 ? n : 1);

  // 2. recording MBID at the same position
  for (const t of local) {
    if (out.has(t.id) || !t.recordingMbid) continue;
    const mbid = t.recordingMbid.toLowerCase();
    const sameRecording = songs.filter((s) => !used.has(s.id) && s.musicBrainzId?.toLowerCase() === mbid);
    const atPosition = sameRecording.filter((s) => disc(s.discNumber) === disc(t.discNo) && (t.trackNo === null || s.track === t.trackNo));
    const pick = atPosition.length === 1 ? atPosition[0] : sameRecording.length === 1 ? sameRecording[0] : undefined;
    if (pick) take(t, pick, 'recording');
  }

  // 3. position + title + length
  for (const t of local) {
    if (out.has(t.id) || t.trackNo === null) continue;
    const title = normTitle(t.title);
    const hits = songs.filter((s) => {
      if (used.has(s.id) || s.track !== t.trackNo || disc(s.discNumber) !== disc(t.discNo)) return false;
      if (title && normTitle(s.title) !== title) return false;
      if (t.durationMs !== null && s.duration !== null && Math.abs(s.duration * 1000 - t.durationMs) > 3000) return false;
      return true;
    });
    if (hits.length === 1) take(t, hits[0]!, 'position');
  }
  return out;
}

/** The folder a file is in, relative to the music root ('' for the root itself). */
export function folderOf(relPath: string): string {
  const p = normalizePath(relPath);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * A scan-root-relative path made relative to the music root. Returns null
 * when the scan root is not inside the music root (then only a full scan
 * and suffix matching can help).
 */
export function musicRelativePath(musicRoot: string, scanRootPath: string, relPath: string): string | null {
  const root = normalizePath(musicRoot).replace(/\/$/, '');
  const scan = normalizePath(scanRootPath).replace(/\/$/, '');
  const rel = normalizePath(relPath);
  if (scan === root) return rel;
  if (scan.startsWith(`${root}/`)) return `${scan.slice(root.length + 1)}/${rel}`;
  return null;
}
