import { describe, expect, it } from 'vitest';
import { normalizeKey, parsePlaylistFile, pickByNames, PlaylistFileError } from './index.js';

describe('normalizeKey', () => {
  it('ignores case, accents, punctuation and a leading article', () => {
    expect(normalizeKey('The Dave Brubeck Quartet')).toBe('dave brubeck quartet');
    expect(normalizeKey('Blue Rondo à la Turk')).toBe(normalizeKey('blue rondo a la turk'));
    expect(normalizeKey('Moanin’')).toBe(normalizeKey("Moanin'"));
    expect(normalizeKey('Simon & Garfunkel')).toBe('simon and garfunkel');
    expect(normalizeKey(null)).toBe('');
  });
});

describe('parsePlaylistFile', () => {
  it('reads tagave’s own file', () => {
    const file = { format: 'tagave-playlist', version: 1, playlists: [{ name: 'Late night', items: [{ title: 'So What', artist: 'Miles Davis', recordingMbid: 'abc', durationMs: 562000 }] }] };
    const out = parsePlaylistFile(JSON.stringify(file));
    expect(out.kind).toBe('tagave');
    expect(out.playlists[0]).toMatchObject({ name: 'Late night', items: [{ title: 'So What', artist: 'Miles Davis' }] });
  });

  it('refuses another version and other JSON', () => {
    expect(() => parsePlaylistFile(JSON.stringify({ format: 'tagave-playlist', version: 2, playlists: [] }))).toThrow(/version 2/);
    expect(() => parsePlaylistFile('{"a":1}')).toThrow(PlaylistFileError);
  });

  it('reads an extended M3U8: titles, artists, lengths and paths', () => {
    const text = '#EXTM3U\n#PLAYLIST:Road trip\n#EXTINF:324,The Dave Brubeck Quartet - Take Five\n/music/Brubeck/Time Out/03 Take Five.flac\n\nC:\\Music\\Davis\\01 So What.mp3\n';
    const out = parsePlaylistFile(text, 'road.m3u8');
    expect(out.kind).toBe('m3u');
    expect(out.playlists[0]!.name).toBe('Road trip');
    expect(out.playlists[0]!.items).toEqual([
      { title: 'Take Five', artist: 'The Dave Brubeck Quartet', durationMs: 324000, path: '/music/Brubeck/Time Out/03 Take Five.flac' },
      { title: 'So What', artist: null, durationMs: null, path: 'C:/Music/Davis/01 So What.mp3' },
    ]);
  });

  it('names an M3U after its file', () => {
    expect(parsePlaylistFile('#EXTM3U\nsong.mp3', 'Sunday morning.m3u').playlists[0]!.name).toBe('Sunday morning');
  });

  it('reads XSPF with a MusicBrainz recording id', () => {
    const text = `<?xml version="1.0"?><playlist version="1" xmlns="http://xspf.org/ns/0/"><title>Ballads &amp; more</title><trackList>
      <track><location>file:///music/Chet%20Baker/03.flac</location><title>It Never Entered My Mind</title><creator>Chet Baker</creator><album>Chet</album><trackNum>3</trackNum><duration>254000</duration>
      <identifier>https://musicbrainz.org/recording/0f3c1d2e-1111-4222-8333-944455556666</identifier></track></trackList></playlist>`;
    const out = parsePlaylistFile(text);
    expect(out.kind).toBe('xspf');
    expect(out.playlists[0]).toEqual({
      name: 'Ballads & more',
      items: [{ title: 'It Never Entered My Mind', artist: 'Chet Baker', album: 'Chet', durationMs: 254000, trackNo: 3, recordingMbid: '0f3c1d2e-1111-4222-8333-944455556666', path: '/music/Chet Baker/03.flac' }],
    });
  });

  it('refuses a file that is no playlist', () => {
    expect(() => parsePlaylistFile('<html></html>')).toThrow(PlaylistFileError);
    expect(() => parsePlaylistFile('hello')).not.toThrow();
  });
});

describe('pickByNames', () => {
  const c = (id: string, title: string, artist: string, durationMs: number | null) => ({ id, title, artist, albumArtist: null, durationMs });
  it('matches the same title and artist within a few seconds, the closest length first', () => {
    const cands = [c('a', 'Take Five', 'Dave Brubeck Quartet', 330000), c('b', 'Take Five', 'The Dave Brubeck Quartet', 325000), c('c', 'Take Five', 'Someone Else', 324000)];
    expect(pickByNames({ title: 'take five', artist: 'The Dave Brubeck Quartet', durationMs: 324000 }, cands)).toBe('b');
  });
  it('refuses a different length or artist', () => {
    expect(pickByNames({ title: 'Take Five', artist: 'Brubeck', durationMs: 324000 }, [c('a', 'Take Five', 'Dave Brubeck', 324000)])).toBeNull();
    expect(pickByNames({ title: 'Take Five', artist: null, durationMs: 400000 }, [c('a', 'Take Five', 'Dave Brubeck', 324000)])).toBeNull();
  });
  it('without an artist, the title and length decide', () => {
    expect(pickByNames({ title: 'Take Five', artist: null, durationMs: null }, [c('a', 'Take Five', 'Dave Brubeck', 324000)])).toBe('a');
  });
});
