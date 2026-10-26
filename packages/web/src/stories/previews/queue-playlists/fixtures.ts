/**
 * Preview fixtures for the queue + playlists design round (rr50). Branch-local:
 * nothing in the app imports this folder.
 */

/** A small generated cover as a data URI, so the previews never hit the network. */
function cover(a: string, b: string, mark: 'ring' | 'bars' | 'dot' | 'arc' = 'ring'): string {
  const marks = {
    ring: '<circle cx="50" cy="50" r="20" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2"/>',
    bars: '<path d="M22 70h56M22 60h40M22 50h48" stroke="#fff" stroke-opacity=".5" stroke-width="3"/>',
    dot: '<circle cx="68" cy="32" r="10" fill="#fff" fill-opacity=".6"/>',
    arc: '<path d="M20 78a30 30 0 0 1 60 0" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3"/>',
  } as const;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${marks[mark]}</svg>`)}`;
}

export interface Album { id: string; title: string; artist: string; year: number; cover: string }
export interface Track { id: string; no: number; title: string; artist: string; albumId: string; sec: number }
export interface Playlist { id: string; name: string; trackIds: string[]; updated: string }

export const albums: Album[] = [
  { id: 'kob', title: 'Kind of Blue', artist: 'Miles Davis', year: 1959, cover: cover('#5ba8c4', '#16202a', 'ring') },
  { id: 'chet', title: 'Chet', artist: 'Chet Baker', year: 1959, cover: cover('#d8b46a', '#3a2a18', 'arc') },
  { id: 'blue-train', title: 'Blue Train', artist: 'John Coltrane', year: 1958, cover: cover('#2f5f9e', '#0b1322', 'bars') },
  { id: 'debby', title: 'Waltz for Debby', artist: 'Bill Evans Trio', year: 1962, cover: cover('#c9c3b8', '#5a4f45', 'dot') },
  { id: 'time-out', title: 'Time Out', artist: 'The Dave Brubeck Quartet', year: 1959, cover: cover('#e0573f', '#4a1610', 'ring') },
  { id: 'moanin', title: 'Moanin’', artist: 'Art Blakey & The Jazz Messengers', year: 1959, cover: cover('#3c8a6a', '#0f2a20', 'bars') },
  { id: 'somethin', title: 'Somethin’ Else', artist: 'Cannonball Adderley', year: 1958, cover: cover('#7b6bb3', '#1d1838', 'arc') },
  { id: 'ah-um', title: 'Mingus Ah Um', artist: 'Charles Mingus', year: 1959, cover: cover('#e3c34a', '#5a3c0a', 'dot') },
];
export const albumById = (id: string) => albums.find((a) => a.id === id)!;

let n = 0;
const t = (albumId: string, no: number, title: string, sec: number, artist?: string): Track => ({ id: `t${++n}`, no, title, artist: artist ?? albumById(albumId).artist, albumId, sec });

export const tracks: Track[] = [
  t('kob', 1, 'So What', 562), t('kob', 2, 'Freddie Freeloader', 586), t('kob', 3, 'Blue in Green', 337), t('kob', 4, 'All Blues', 694), t('kob', 5, 'Flamenco Sketches', 566),
  t('chet', 1, 'Alone Together', 413), t('chet', 2, 'How High the Moon', 265), t('chet', 3, 'It Never Entered My Mind', 254), t('chet', 4, 'Tis Autumn', 335),
  t('blue-train', 1, 'Blue Train', 643), t('blue-train', 2, 'Moment’s Notice', 551), t('blue-train', 3, 'Locomotion', 434),
  t('debby', 1, 'My Foolish Heart', 296), t('debby', 2, 'Waltz for Debby', 415),
  t('time-out', 1, 'Blue Rondo à la Turk', 404), t('time-out', 3, 'Take Five', 324),
  t('moanin', 1, 'Moanin’', 575), t('somethin', 1, 'Autumn Leaves', 660), t('ah-um', 1, 'Better Git It in Your Soul', 443), t('ah-um', 2, 'Goodbye Pork Pie Hat', 345),
];
export const trackById = (id: string) => tracks.find((x) => x.id === id)!;
export const tracksOf = (albumId: string) => tracks.filter((x) => x.albumId === albumId);
const byTitle = (title: string) => tracks.find((x) => x.title === title)!;

/** The queue the previews show: Chet playing (from the album), two tracks queued by hand, the rest of the album, and what was heard before. */
export const queue = {
  history: [byTitle('So What'), byTitle('Freddie Freeloader'), byTitle('Blue in Green')],
  current: byTitle('Alone Together'),
  /** "Play next" / "Add to queue": ahead of the album's own order */
  queued: [byTitle('Take Five'), byTitle('My Foolish Heart')],
  /** the rest of what was started (the album, a playlist) */
  context: { kind: 'album' as const, name: 'Chet', tracks: [byTitle('How High the Moon'), byTitle('It Never Entered My Mind'), byTitle('Tis Autumn')] },
  position: 141,
};

export const playlists: Playlist[] = [
  { id: 'late', name: 'Late night', trackIds: ['Blue in Green', 'Alone Together', 'My Foolish Heart', 'Goodbye Pork Pie Hat', 'Flamenco Sketches', 'Autumn Leaves', 'It Never Entered My Mind', 'Waltz for Debby', 'Tis Autumn', 'So What', 'Take Five', 'Moment’s Notice'].map((x) => byTitle(x).id), updated: '2026-10-24' },
  { id: 'sunday', name: 'Sunday morning', trackIds: ['Waltz for Debby', 'How High the Moon', 'Take Five', 'Freddie Freeloader'].map((x) => byTitle(x).id), updated: '2026-10-20' },
  { id: 'hardbop', name: 'Hard bop', trackIds: ['Moanin’', 'Blue Train', 'Locomotion', 'Better Git It in Your Soul', 'Moment’s Notice'].map((x) => byTitle(x).id), updated: '2026-10-12' },
  { id: 'trios', name: 'Piano trios', trackIds: ['My Foolish Heart', 'Waltz for Debby'].map((x) => byTitle(x).id), updated: '2026-09-30' },
  { id: 'road', name: 'Road trip', trackIds: ['Blue Rondo à la Turk', 'Take Five', 'All Blues', 'Better Git It in Your Soul', 'Autumn Leaves', 'Blue Train'].map((x) => byTitle(x).id), updated: '2026-09-14' },
  { id: 'ballads', name: 'Ballads', trackIds: ['It Never Entered My Mind'].map((x) => byTitle(x).id), updated: '2026-09-02' },
];
export const playlistById = (id: string) => playlists.find((p) => p.id === id)!;

/** Up to four distinct album covers, in the playlist's order: the mosaic. */
export function mosaicOf(p: Playlist): string[] {
  const seen: string[] = [];
  for (const id of p.trackIds) {
    const c = albumById(trackById(id).albumId).cover;
    if (!seen.includes(c)) seen.push(c);
    if (seen.length === 4) break;
  }
  return seen;
}

export function totalSec(ids: readonly string[]): number {
  return ids.reduce((s, id) => s + trackById(id).sec, 0);
}

export function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function longDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
