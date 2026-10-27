/**
 * Playlists: reading a playlist file (tagave's own *.tagave-playlist.json,
 * M3U / M3U8, XSPF) and the last step of matching its entries to tracks
 * (normalised artist, title and length). The database steps before it (by
 * recording MBID, then release MBID with disc and track) are the API's
 * (api › lib/playlists.ts).
 */
import { playlistFileSchema, PLAYLIST_FILE_FORMAT, type PlaylistFileItem } from '@tagave/shared';

export interface ParsedItem extends PlaylistFileItem {
  /** M3U / XSPF only: the entry's file location, matched against the library's paths */
  path?: string | null;
}

export interface ParsedPlaylist {
  name: string;
  items: ParsedItem[];
}

export type PlaylistFileKind = 'tagave' | 'm3u' | 'xspf';

export class PlaylistFileError extends Error {}

/** Case, accents, punctuation, spacing and a leading article do not count. */
export function normalizeKey(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .replace(/\s+/g, ' ');
}

const baseName = (fileName: string | undefined) =>
  (fileName ?? '').split(/[\\/]/).pop()!.replace(/\.(tagave-playlist\.json|json|m3u8?|xspf)$/i, '').trim();

const decodeXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decodeXml(m[1]!) : null;
};

const MBID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function fileLocation(raw: string): string {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(localhost)?/i, '');
    try { p = decodeURIComponent(p); } catch { /* keep it as it is */ }
  }
  return p.replace(/\\/g, '/');
}

function parseM3u(text: string, fileName?: string): ParsedPlaylist {
  const items: ParsedItem[] = [];
  let pending: { title: string; artist: string | null; durationMs: number | null } | null = null;
  let name = baseName(fileName) || 'Imported playlist';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#PLAYLIST:')) { name = line.slice(10).trim() || name; continue; }
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)[^,]*,(.*)$/.exec(line);
      if (m) {
        const secs = Number(m[1]);
        const label = m[2]!.trim();
        const dash = label.indexOf(' - ');
        pending = {
          artist: dash > 0 ? label.slice(0, dash).trim() : null,
          title: dash > 0 ? label.slice(dash + 3).trim() : label,
          durationMs: secs > 0 ? Math.round(secs * 1000) : null,
        };
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const path = fileLocation(line);
    const file = path.split('/').pop() ?? path;
    items.push({
      title: pending?.title || file.replace(/\.[^.]+$/, '').replace(/^\d+[\s.-]+/, ''),
      artist: pending?.artist ?? null,
      durationMs: pending?.durationMs ?? null,
      path,
    });
    pending = null;
  }
  return { name, items };
}

function parseXspf(text: string, fileName?: string): ParsedPlaylist {
  const list = /<trackList[^>]*>([\s\S]*?)<\/trackList>/i.exec(text)?.[1] ?? '';
  const head = text.slice(0, Math.max(0, text.search(/<trackList/i)));
  const name = tag(head, 'title') || baseName(fileName) || 'Imported playlist';
  const items: ParsedItem[] = [];
  for (const m of list.matchAll(/<track(?:\s[^>]*)?>([\s\S]*?)<\/track>/gi)) {
    const block = m[1]!;
    const title = tag(block, 'title');
    const location = tag(block, 'location');
    const identifier = tag(block, 'identifier');
    const duration = Number(tag(block, 'duration'));
    const trackNum = Number(tag(block, 'trackNum'));
    const path = location ? fileLocation(location) : null;
    const recordingMbid = identifier && /musicbrainz\.org\/recording\//i.test(identifier) ? MBID_RE.exec(identifier)?.[1]?.toLowerCase() ?? null : null;
    const fallback = path ? (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '') : null;
    if (!title && !fallback) continue;
    items.push({
      title: title || fallback!,
      artist: tag(block, 'creator'),
      album: tag(block, 'album'),
      durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      trackNo: Number.isInteger(trackNum) && trackNum > 0 ? trackNum : null,
      recordingMbid,
      path,
    });
  }
  return { name, items };
}

/** The playlists in a file, whichever of the three kinds it is. */
export function parsePlaylistFile(text: string, fileName?: string): { kind: PlaylistFileKind; playlists: ParsedPlaylist[] } {
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('{')) {
    let json: unknown;
    try { json = JSON.parse(body); } catch { throw new PlaylistFileError('This file is not a playlist tagave can read.'); }
    if ((json as { format?: unknown })?.format !== PLAYLIST_FILE_FORMAT) throw new PlaylistFileError('This file is not a playlist tagave can read.');
    const parsed = playlistFileSchema.safeParse(json);
    if (!parsed.success) {
      const v = (json as { version?: unknown }).version;
      throw new PlaylistFileError(v !== 1 ? `This playlist file is version ${String(v)}; this tagave reads version 1.` : 'This playlist file is damaged.');
    }
    return { kind: 'tagave', playlists: parsed.data.playlists.map((p) => ({ name: p.name.trim() || 'Imported playlist', items: p.items })) };
  }
  if (body.startsWith('<')) {
    if (!/<playlist[\s>]/i.test(body)) throw new PlaylistFileError('This file is not a playlist tagave can read.');
    return { kind: 'xspf', playlists: [parseXspf(body, fileName)] };
  }
  const m3u = parseM3u(body, fileName);
  if (m3u.items.length === 0 && !/^#EXTM3U/i.test(body)) throw new PlaylistFileError('This file is not a playlist tagave can read.');
  return { kind: 'm3u', playlists: [m3u] };
}

export interface MatchCandidate {
  id: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  durationMs: number | null;
}

/** Lengths further apart than this are different recordings. */
export const DURATION_SLACK_MS = 3000;

/**
 * The last matching step: the same title and artist (normalised), and the
 * same length within a few seconds when both are known. The closest length
 * wins; nothing when no candidate fits.
 */
export function pickByNames(item: Pick<PlaylistFileItem, 'title' | 'artist' | 'durationMs'>, candidates: readonly MatchCandidate[]): string | null {
  const title = normalizeKey(item.title);
  const artist = normalizeKey(item.artist);
  if (!title) return null;
  let best: { id: string; gap: number } | null = null;
  for (const c of candidates) {
    if (normalizeKey(c.title) !== title) continue;
    if (artist && normalizeKey(c.artist) !== artist && normalizeKey(c.albumArtist) !== artist) continue;
    const gap = item.durationMs != null && c.durationMs != null ? Math.abs(item.durationMs - c.durationMs) : 0;
    if (gap > DURATION_SLACK_MS) continue;
    if (!best || gap < best.gap) best = { id: c.id, gap };
  }
  return best?.id ?? null;
}
