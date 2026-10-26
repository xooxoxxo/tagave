/**
 * Which platform a URL belongs to, and the one URL tagave keeps for it.
 * Only album pages count for an album and only artist pages for an artist:
 * a track, a playlist that is not an album, a shop page or a video is no
 * link. Qobuz links are rewritten to play.qobuz.com, which opens the Qobuz
 * app on Android; Apple's tracking parameters are dropped.
 */
import type { ListenPlatform } from '@tagave/shared';

export type ListenTarget = 'album' | 'artist';

export interface PlatformUrl {
  platform: ListenPlatform;
  url: string;
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');

export function classifyListenUrl(raw: string, target: ListenTarget): PlatformUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = host(u);
  const path = u.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean);
  const album = target === 'album';

  // open.spotify.com/album/<id>, /artist/<id> (an optional intl-xx segment first)
  if (h === 'open.spotify.com') {
    const s = seg[0]?.startsWith('intl-') ? seg.slice(1) : seg;
    if (s[0] === (album ? 'album' : 'artist') && s[1] && /^[A-Za-z0-9]{10,40}$/.test(s[1])) {
      return { platform: 'spotify', url: `https://open.spotify.com/${s[0]}/${s[1]}` };
    }
    return null;
  }

  // music.apple.com/<storefront>/album/<slug>/<id>, itunes.apple.com the same
  if (h === 'music.apple.com' || h === 'itunes.apple.com') {
    const i = seg.indexOf(album ? 'album' : 'artist');
    const id = i >= 0 ? seg[seg.length - 1] : undefined;
    if (i < 0 || !id || !/^(id)?\d+$/.test(id)) return null;
    return { platform: 'apple', url: `https://music.apple.com/${seg.join('/')}` };
  }

  // www.qobuz.com/<locale>/album/<slug>/<id>, /interpreter/<slug>/<id>; open. and play.qobuz.com/album/<id>, /artist/<id>
  if (h === 'qobuz.com' || h === 'open.qobuz.com' || h === 'play.qobuz.com') {
    const kinds = album ? ['album'] : ['interpreter', 'artist'];
    const i = seg.findIndex((s) => kinds.includes(s));
    const id = i >= 0 ? seg[seg.length - 1] : undefined;
    if (i < 0 || !id || id === seg[i] || !/^[A-Za-z0-9]+$/.test(id)) return null;
    return { platform: 'qobuz', url: `https://play.qobuz.com/${album ? 'album' : 'artist'}/${id}` };
  }

  // tidal.com/album/<id>, tidal.com/browse/album/<id>, listen.tidal.com/album/<id>
  if (h === 'tidal.com' || h === 'listen.tidal.com') {
    const s = seg[0] === 'browse' ? seg.slice(1) : seg;
    if (s[0] === (album ? 'album' : 'artist') && s[1] && /^\d+$/.test(s[1])) {
      return { platform: 'tidal', url: `https://tidal.com/${s[0]}/${s[1]}` };
    }
    return null;
  }

  // deezer.com/<lang>/album/<id>
  if (h === 'deezer.com') {
    const i = seg.indexOf(album ? 'album' : 'artist');
    const id = i >= 0 ? seg[i + 1] : undefined;
    if (!id || !/^\d+$/.test(id)) return null;
    return { platform: 'deezer', url: `https://www.deezer.com/${album ? 'album' : 'artist'}/${id}` };
  }

  // music.youtube.com/playlist?list=OLAK5uy_… (an album), /browse/MPREb_… (an album), /channel/<id> (an artist)
  if (h === 'music.youtube.com') {
    if (album) {
      const list = u.searchParams.get('list');
      if (seg[0] === 'playlist' && list && /^OLAK5uy_[A-Za-z0-9_-]+$/.test(list)) return { platform: 'youtube-music', url: `https://music.youtube.com/playlist?list=${list}` };
      if (seg[0] === 'browse' && seg[1] && /^MPREb_[A-Za-z0-9_-]+$/.test(seg[1])) return { platform: 'youtube-music', url: `https://music.youtube.com/browse/${seg[1]}` };
      return null;
    }
    if (seg[0] === 'channel' && seg[1] && /^UC[A-Za-z0-9_-]+$/.test(seg[1])) return { platform: 'youtube-music', url: `https://music.youtube.com/channel/${seg[1]}` };
    return null;
  }

  // <name>.bandcamp.com/album/<slug>; the artist is the subdomain's front page
  if (h.endsWith('.bandcamp.com') && h !== 'daily.bandcamp.com') {
    const sub = h.slice(0, -'.bandcamp.com'.length);
    if (!/^[a-z0-9-]+$/.test(sub)) return null;
    if (album) return seg[0] === 'album' && seg[1] ? { platform: 'bandcamp', url: `https://${h}/album/${seg[1]}` } : null;
    return seg.length === 0 || seg[0] === 'music' ? { platform: 'bandcamp', url: `https://${h}/` } : null;
  }

  // music.amazon.<tld>/albums/<asin>, /artists/<asin>; amazon.<tld>/music/player/albums/<asin>
  const amazon = /^(music\.)?amazon\.[a-z.]+$/.exec(h);
  if (amazon) {
    const s = amazon[1] ? seg : seg[0] === 'music' && seg[1] === 'player' ? seg.slice(2) : [];
    if (s[0] === (album ? 'albums' : 'artists') && s[1] && /^[A-Z0-9]{10}$/.test(s[1])) {
      return { platform: 'amazon', url: `https://${amazon[1] ? h : `music.${h}`}/${s[0]}/${s[1]}` };
    }
    return null;
  }
  return null;
}

/** MusicBrainz relationship types that point at a place to listen or buy the music. */
const RELEASE_LINK_TYPES = new Set(['streaming', 'free streaming', 'purchase for download', 'download for free']);
const ARTIST_LINK_TYPES = new Set(['streaming', 'free streaming', 'purchase for download', 'download for free', 'bandcamp', 'youtube music']);

/** The platform links among a MusicBrainz entity's url relationships, first per platform wins. */
export function linksFromRelations(rels: ReadonlyArray<{ type: string; url: string }>, target: ListenTarget): PlatformUrl[] {
  const types = target === 'album' ? RELEASE_LINK_TYPES : ARTIST_LINK_TYPES;
  const out = new Map<ListenPlatform, PlatformUrl>();
  for (const r of rels) {
    if (!types.has(r.type)) continue;
    const p = classifyListenUrl(r.url, target);
    if (p && !out.has(p.platform)) out.set(p.platform, p);
  }
  return [...out.values()];
}

/**
 * Wikidata's identifier properties, and the URL each id makes. Albums are
 * found by MusicBrainz release group id (P436), artists by artist id (P434).
 */
export const WIKIDATA_ALBUM_PROPS: ReadonlyArray<{ platform: ListenPlatform; prop: string; url: (id: string) => string | null }> = [
  { platform: 'spotify', prop: 'P2205', url: (id) => (/^[A-Za-z0-9]{22}$/.test(id) ? `https://open.spotify.com/album/${id}` : null) },
  { platform: 'apple', prop: 'P2281', url: (id) => (/^\d+$/.test(id) ? `https://music.apple.com/album/${id}` : null) },
  { platform: 'qobuz', prop: 'P11770', url: (id) => (/^[A-Za-z0-9]+$/.test(id) ? `https://play.qobuz.com/album/${id}` : null) },
  { platform: 'tidal', prop: 'P4577', url: (id) => (/^\d+$/.test(id) ? `https://tidal.com/album/${id}` : null) },
  { platform: 'deezer', prop: 'P2723', url: (id) => (/^\d+$/.test(id) ? `https://www.deezer.com/album/${id}` : null) },
];

export const WIKIDATA_ARTIST_PROPS: ReadonlyArray<{ platform: ListenPlatform; prop: string; url: (id: string) => string | null }> = [
  { platform: 'spotify', prop: 'P1902', url: (id) => (/^[A-Za-z0-9]{22}$/.test(id) ? `https://open.spotify.com/artist/${id}` : null) },
  { platform: 'apple', prop: 'P2850', url: (id) => (/^\d+$/.test(id) ? `https://music.apple.com/artist/${id}` : null) },
  // P7071 holds the artist's slug on qobuz.com ("radiohead"), not the player's numeric id
  { platform: 'qobuz', prop: 'P7071', url: (id) => (/^\d+$/.test(id) ? `https://play.qobuz.com/artist/${id}` : /^[a-z0-9-]+$/.test(id) ? `https://www.qobuz.com/interpreter/${id}/download-streaming-albums` : null) },
  { platform: 'tidal', prop: 'P4576', url: (id) => (/^\d+$/.test(id) ? `https://tidal.com/artist/${id}` : null) },
  { platform: 'deezer', prop: 'P2722', url: (id) => (/^\d+$/.test(id) ? `https://www.deezer.com/artist/${id}` : null) },
  { platform: 'bandcamp', prop: 'P3283', url: (id) => (/^[a-z0-9-]+$/.test(id) ? `https://${id}.bandcamp.com/` : null) },
  { platform: 'amazon', prop: 'P6276', url: (id) => (/^[A-Z0-9]{10}$/.test(id) ? `https://music.amazon.com/artists/${id}` : null) },
];

/** Apple's lookup answer's album page, without its tracking parameters. */
export function appleAlbumUrl(raw: string): string | null {
  const p = classifyListenUrl(raw, 'album');
  return p?.platform === 'apple' ? p.url : null;
}
