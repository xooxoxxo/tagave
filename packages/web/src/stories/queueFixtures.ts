/** Shared fixtures for the queue, Now Playing and playlists stories: a few albums, their tracks, some playlists. */
import type { PlayHistoryEntry, PlaylistSummary, PlaylistView } from '@tagave/shared';
import type { QueueEntry } from '../player/engine';

function cover(a: string, b: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="18" fill="none" stroke="#fff" stroke-opacity=".5"/></svg>`)}`;
}

export const COVERS = {
  chet: cover('#d8b46a', '#3a2a18'),
  kob: cover('#5ba8c4', '#16202a'),
  timeOut: cover('#e0573f', '#4a1610'),
  debby: cover('#c9c3b8', '#5a4f45'),
};

let n = 0;
const t = (album: keyof typeof COVERS, albumName: string, artist: string, no: number, title: string, sec: number, origin: 'context' | 'queued' = 'context'): QueueEntry => ({
  uid: `u${++n}`, origin, localTrackId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, discNo: 1, trackNo: no, title, artist, album: albumName, albumArtist: artist,
  albumId: `album-${album}`, coverUrl: COVERS[album], artists: [{ id: `artist-${album}`, name: artist }], year: 1959,
  durationMs: sec * 1000, container: 'flac', codec: 'FLAC', lossless: true, mime: 'audio/flac', available: true, reason: null,
});

/** Chet playing, two tracks added by hand, the rest of the album. */
export const QUEUE: QueueEntry[] = [
  t('chet', 'Chet', 'Chet Baker', 1, 'Alone Together', 413),
  t('timeOut', 'Time Out', 'The Dave Brubeck Quartet', 3, 'Take Five', 324, 'queued'),
  t('debby', 'Waltz for Debby', 'Bill Evans Trio', 1, 'My Foolish Heart', 296, 'queued'),
  t('chet', 'Chet', 'Chet Baker', 2, 'How High the Moon', 265),
  t('chet', 'Chet', 'Chet Baker', 3, 'It Never Entered My Mind', 254),
  t('chet', 'Chet', 'Chet Baker', 4, 'Tis Autumn', 335),
];

export const HISTORY: PlayHistoryEntry[] = [
  { id: 'h1', localTrackId: 'x1', albumId: 'album-kob', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: COVERS.kob, durationMs: 337_000, playedAt: '2026-10-26T21:40:00Z' },
  { id: 'h2', localTrackId: 'x2', albumId: 'album-kob', title: 'Freddie Freeloader', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: COVERS.kob, durationMs: 586_000, playedAt: '2026-10-26T21:30:00Z' },
  { id: 'h3', localTrackId: null, albumId: null, title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: null, durationMs: 562_000, playedAt: '2026-10-26T21:20:00Z' },
];

export const PLAYLISTS: PlaylistSummary[] = [
  { id: 'p1', name: 'Late night', tracks: 12, durationMs: 4_380_000, covers: [COVERS.kob, COVERS.chet, COVERS.timeOut, COVERS.debby], updatedAt: '2026-10-26T20:00:00Z' },
  { id: 'p2', name: 'Sunday morning', tracks: 4, durationMs: 1_290_000, covers: [COVERS.debby, COVERS.chet, COVERS.timeOut, COVERS.kob], updatedAt: '2026-10-25T20:00:00Z' },
  { id: 'p3', name: 'Piano trios', tracks: 2, durationMs: 711_000, covers: [COVERS.debby], updatedAt: '2026-10-20T20:00:00Z' },
  { id: 'p4', name: 'Ballads', tracks: 0, durationMs: 0, covers: [], updatedAt: '2026-10-10T20:00:00Z' },
];

export const PLAYLIST: PlaylistView = {
  ...PLAYLISTS[0]!,
  tracks: 5,
  durationMs: 1_632_000,
  items: [
    { id: 'i1', localTrackId: 'l1', albumId: 'album-kob', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: COVERS.kob, durationMs: 337_000 },
    { id: 'i2', localTrackId: 'l2', albumId: 'album-chet', title: 'Alone Together', artist: 'Chet Baker', album: 'Chet', coverUrl: COVERS.chet, durationMs: 413_000 },
    { id: 'i3', localTrackId: 'l3', albumId: 'album-timeOut', title: 'Take Five', artist: 'The Dave Brubeck Quartet', album: 'Time Out', coverUrl: COVERS.timeOut, durationMs: 324_000 },
    { id: 'i4', localTrackId: null, albumId: null, title: 'Gone Soon', artist: 'Someone', album: 'Elsewhere', coverUrl: null, durationMs: 262_000 },
    { id: 'i5', localTrackId: 'l5', albumId: 'album-debby', title: 'My Foolish Heart', artist: 'Bill Evans Trio', album: 'Waltz for Debby', coverUrl: COVERS.debby, durationMs: 296_000 },
  ],
};
