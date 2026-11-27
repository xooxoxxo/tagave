/**
 * An album whose files are offline: the line under its facts (with its help
 * behind "?"), Play and Shuffle waiting with one note, the Rescan hint, and
 * nothing of the player's when the player module is off.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AlbumSummary, PlayerAlbumAvailability } from '@tagave/shared';
import { AlbumOfflineLine, albumPlayWait, offlineLine, rescanHint } from './albumOffline';
import { AlbumGridCard } from './AlbumGridCard';
import { AlbumActionRow } from './AlbumActionRow';
import { albumActionContext } from './albumActions';

const NOW = new Date(2026, 10, 24, 18, 0);
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();
const offline = (over: Partial<PlayerAlbumAvailability> = {}): PlayerAlbumAvailability => ({ albumId: 'al', tracks: 10, playable: 0, reason: 'offline', scan: null, since: at(24, 14, 2), ...over });
const noop = () => undefined;

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
const visible = (html: string) => html.replace(/<div[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, '').replace(/<[^>]+>/g, '');

describe('offlineLine', () => {
  it('all the files: "Files offline since 14:02", with what it means behind "?"', () => {
    expect(offlineLine({ filesOffline: 'all', offlineSince: at(24, 14, 2) }, NOW)).toEqual({
      text: 'Files offline since 14:02',
      help: 'The music folder with these files can\'t be reached. You can still browse, edit and plan. tagave writes your changes when it\'s back.',
    });
  });

  it('another day gives the date too', () => {
    expect(offlineLine({ filesOffline: 'all', offlineSince: at(23, 9, 10) }, NOW)?.text).toBe('Files offline since 23 Nov, 09:10');
  });

  it('all, with no time known: just "Files offline"', () => {
    expect(offlineLine({ filesOffline: 'all', offlineSince: null }, NOW)?.text).toBe('Files offline');
  });

  it('some of the files: "Some files offline", with its own help', () => {
    expect(offlineLine({ filesOffline: 'some', offlineSince: at(24, 14, 2) }, NOW)).toEqual({
      text: 'Some files offline',
      help: 'Some of this album\'s files are in a music folder tagave can\'t reach.',
    });
  });

  it('online (or an older API): no line', () => {
    expect(offlineLine({ filesOffline: null, offlineSince: null }, NOW)).toBeNull();
    expect(offlineLine({}, NOW)).toBeNull();
  });

  it('renders the words, the help behind a "?" only', () => {
    const line = offlineLine({ filesOffline: 'all', offlineSince: at(24, 14, 2) }, NOW)!;
    const html = renderToStaticMarkup(<AlbumOfflineLine line={line} />);
    expect(visible(html)).toBe('Files offline since 14:02?');
    expect(html).toContain('aria-label="Help: Files offline since 14:02"');
    expect(hidden(html)).toBe(line.help.replace(/'/g, '&#x27;'));
  });
});

describe('Play while the files are offline', () => {
  const base = { playerInstalled: true, canPlay: true, scan: null, filesOffline: null } as const;

  it('Play waits with "Can\'t play: the files are offline"', () => {
    expect(albumPlayWait({ ...base, availability: offline() })).toEqual({ note: 'Can\'t play: the files are offline', disabled: true });
  });

  it('the album says so before availability answers', () => {
    expect(albumPlayWait({ ...base, availability: undefined, filesOffline: 'all' })).toEqual({ note: 'Can\'t play: the files are offline', disabled: true });
  });

  it('some files offline: Play stays, it plays what it can', () => {
    expect(albumPlayWait({ ...base, availability: { ...offline(), playable: 4, reason: null }, filesOffline: 'some' })).toEqual({ note: null, disabled: false });
  });

  it('Play and Shuffle both wait, under one note', () => {
    const wait = albumPlayWait({ ...base, availability: offline() });
    const html = renderToStaticMarkup(<AlbumActionRow context={albumActionContext({ playerInstalled: true })} play={{ mode: 'play', onPlay: noop, onToggle: noop, onShuffle: noop, ...wait }} />);
    expect(html).toMatch(/<button(?=[^>]*aria-label="Play")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toMatch(/<button(?=[^>]*aria-label="Shuffle")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toContain('Can&#x27;t play: the files are offline');
  });

  it('keeps the older reasons as they were', () => {
    expect(albumPlayWait({ ...base, availability: offline({ reason: 'no_file' }) })).toEqual({ note: 'The files are missing or could not be read', disabled: true });
    expect(albumPlayWait({ ...base, availability: offline({ reason: 'cue' }) })).toEqual({ note: 'Tracks inside a CUE image cannot be played yet', disabled: true });
    expect(albumPlayWait({ ...base, availability: offline({ reason: 'not_scanned' }) })).toEqual({ note: 'Not on the player yet', disabled: false });
    expect(albumPlayWait({ ...base, canPlay: false, availability: undefined })).toEqual({ note: 'The player is not answering right now', disabled: true });
  });

  it('with the player module off: no note, and no row at all', () => {
    expect(albumPlayWait({ playerInstalled: false, canPlay: false, availability: undefined, scan: null, filesOffline: 'all' }).note).toBeNull();
    expect(renderToStaticMarkup(<AlbumActionRow context={albumActionContext({ playerInstalled: false })} play={null} />)).toBe('');
  });
});

describe('the albums grid tile', () => {
  const album = (over: Partial<AlbumSummary> = {}): AlbumSummary => ({
    id: '00000000-0000-7000-8000-000000000001', libraryId: '00000000-0000-7000-8000-000000000002', localAlbumId: '00000000-0000-7000-8000-000000000003',
    title: 'Kind of Blue', artistCredit: 'Miles Davis', year: 1959, formats: ['flac'], isLossless: true, state: 'matched', trackCount: 5,
    coverUrl: 'https://tagave.test/api/v1/images/album/a1', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', ...over,
  });
  const card = (a: AlbumSummary) => renderToStaticMarkup(<AlbumGridCard album={a} width={200} pad={16} narrow={false} selected={false} maintenance={false} attention={false} />);

  it('says "Files offline" for all or some of the files, for everyone; the cover still shows', () => {
    for (const filesOffline of ['all', 'some'] as const) {
      const html = card(album({ filesOffline, offlineSince: '2026-11-24T14:02:00.000Z' }));
      expect(html.match(/Files offline/g), filesOffline).toHaveLength(1);
      expect(html).toContain('<img');
    }
  });

  it('online: no tag', () => {
    expect(card(album())).not.toContain('Files offline');
    expect(card(album({ filesOffline: null }))).not.toContain('Files offline');
  });
});

describe('Rescan folder while offline', () => {
  it('stays, with the hint "Waits for the music folder"', () => {
    expect(rescanHint('all')).toBe('Waits for the music folder');
    expect(rescanHint('some')).toBe('Waits for the music folder');
    expect(rescanHint(null)).toBeUndefined();
    expect(rescanHint(undefined)).toBeUndefined();
  });
});
