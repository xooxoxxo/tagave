import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sealSecret } from '../crypto/secretbox.js';
import { authParams, methodUrl, streamUrl, subsonicCall, searchWords, SubsonicError, type ServerSong } from './subsonic.js';
import { folderOf, matchTracks, musicRelativePath, pathTailMatches, type LocalTrackRef } from './match.js';
import { playerServerKey, resolvePlayerBackend } from './config.js';

const server = { url: 'http://player:4533/', username: 'admin', password: 'sesame' };

describe('subsonic auth', () => {
  it('sends md5(password + salt), never the password', () => {
    const q = authParams(server, 'c19b2d');
    expect(q.get('t')).toBe(createHash('md5').update('sesamec19b2d').digest('hex'));
    expect(q.get('s')).toBe('c19b2d');
    expect(q.get('u')).toBe('admin');
    expect(q.get('c')).toBe('tagave');
    expect(q.get('f')).toBe('json');
    expect(q.toString()).not.toContain('sesame');
    expect(q.has('p')).toBe(false);
  });

  it('uses a new salt every call', () => {
    expect(authParams(server).get('s')).not.toBe(authParams(server).get('s'));
  });

  it('builds method and stream URLs on the base address', () => {
    expect(methodUrl(server, 'ping')).toMatch(/^http:\/\/player:4533\/rest\/ping\?/);
    const raw = new URL(streamUrl(server, 'abc', { format: 'raw', maxBitRate: 192, timeOffset: 30 }));
    expect(raw.searchParams.get('format')).toBe('raw');
    expect(raw.searchParams.has('maxBitRate')).toBe(false);
    expect(raw.searchParams.has('timeOffset')).toBe(false);
    const opus = new URL(streamUrl(server, 'abc', { format: 'opus', maxBitRate: 160, timeOffset: 42 }));
    expect(opus.searchParams.get('maxBitRate')).toBe('160');
    expect(opus.searchParams.get('timeOffset')).toBe('42');
    expect(methodUrl(server, 'startScan', { target: ['1:A/B', '1:C'] })).toContain('target=1%3AA%2FB&target=1%3AC');
  });

  it('turns a Subsonic error into plain words', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }), { status: 200 })) as typeof fetch;
    await expect(subsonicCall(server, 'ping', {}, { fetchImpl })).rejects.toMatchObject({ code: 40, message: 'The server refused the username or password' });
  });

  it('says when the address is not a Subsonic server', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(subsonicCall(server, 'ping', {}, { fetchImpl })).rejects.toBeInstanceOf(SubsonicError);
  });

  it('searches by words', () => {
    expect(searchWords('Sgt. Pepper’s Lonely Hearts Club Band (Remastered)')).toBe('Sgt Pepper s Lonely Hearts Club Band Remastered');
  });
});

const song = (o: Partial<ServerSong> & { id: string }): ServerSong => ({
  title: '', album: null, albumId: 'al', artist: null, track: null, discNumber: 1, duration: null,
  path: null, suffix: 'flac', contentType: 'audio/flac', musicBrainzId: null, ...o,
});
const local = (o: Partial<LocalTrackRef> & { id: string }): LocalTrackRef => ({
  relPath: '', recordingMbid: null, discNo: 1, trackNo: null, title: null, durationMs: null, ...o,
});

describe('matching local tracks to server songs', () => {
  it('compares path tails at a boundary, NFC on both sides', () => {
    expect(pathTailMatches('/music/Björk/Post/01.flac', 'Björk/Post/01.flac'.normalize('NFD'))).toBe(true);
    expect(pathTailMatches('/music/XBjörk/Post/01.flac', 'Björk/Post/01.flac')).toBe(false);
    expect(pathTailMatches('Björk/Post/01.flac', 'Björk/Post/01.flac')).toBe(true);
  });

  it('pins the exact copy by path when a release exists twice', () => {
    const songs = [
      song({ id: 'a1', path: '/music/A/Album (CD)/01.flac', track: 1, musicBrainzId: 'rec-1' }),
      song({ id: 'b1', path: '/music/A/Album (Vinyl)/01.flac', track: 1, musicBrainzId: 'rec-1' }),
    ];
    const m = matchTracks([local({ id: 't', relPath: 'A/Album (Vinyl)/01.flac', trackNo: 1, recordingMbid: 'rec-1' })], songs);
    expect(m.get('t')).toMatchObject({ matchedBy: 'path', song: { id: 'b1' } });
  });

  it('falls back to the recording MBID at the same position, then to position + title + length', () => {
    const songs = [
      song({ id: 's1', path: 'Artist/Album/01 - One.flac', track: 1, discNumber: 1, musicBrainzId: 'REC-1', title: 'One', duration: 200 }),
      song({ id: 's2', path: 'Artist/Album/02 - Two.flac', track: 2, discNumber: 1, title: 'Two', duration: 180 }),
      song({ id: 's3', path: 'Artist/Album/01 - Three.flac', track: 1, discNumber: 2, title: 'Three', duration: 100 }),
    ];
    const m = matchTracks([
      local({ id: 'one', relPath: 'x/01.flac', recordingMbid: 'rec-1', trackNo: 1 }),
      local({ id: 'two', relPath: 'x/02.flac', trackNo: 2, title: 'two', durationMs: 181_000 }),
      local({ id: 'three', relPath: 'x/d2-01.flac', discNo: 2, trackNo: 1, title: 'Three!', durationMs: 100_500 }),
      local({ id: 'four', relPath: 'x/04.flac', trackNo: 4, title: 'Four' }),
    ], songs);
    expect(m.get('one')).toMatchObject({ matchedBy: 'recording', song: { id: 's1' } });
    expect(m.get('two')).toMatchObject({ matchedBy: 'position', song: { id: 's2' } });
    expect(m.get('three')).toMatchObject({ matchedBy: 'position', song: { id: 's3' } });
    expect(m.has('four')).toBe(false);
  });

  it('uses each song once and refuses a length that is far off', () => {
    const songs = [song({ id: 's', path: 'p/01.flac', track: 1, title: 'Song', duration: 300 })];
    const m = matchTracks([
      local({ id: 'a', relPath: 'q/01.flac', trackNo: 1, title: 'Song', durationMs: 120_000 }),
    ], songs);
    expect(m.size).toBe(0);
  });

  it('makes scan-root paths relative to the music root', () => {
    expect(musicRelativePath('/mnt/music', '/mnt/music', 'A/B/01.flac')).toBe('A/B/01.flac');
    expect(musicRelativePath('/mnt/music', '/mnt/music/Jazz', 'A/01.flac')).toBe('Jazz/A/01.flac');
    expect(musicRelativePath('/mnt/music', '/srv/other', 'A/01.flac')).toBeNull();
    expect(folderOf('Jazz/A/01.flac')).toBe('Jazz/A');
    expect(folderOf('01.flac')).toBe('');
  });
});

describe('player backend', () => {
  const secret = 'x'.repeat(44);
  it('prefers the bundled server from the environment', () => {
    const env = { TAGAVE_PLAYER_URL: 'http://player:4533', TAGAVE_PLAYER_USER: 'admin', TAGAVE_PLAYER_PASSWORD: 'p' };
    const b = resolvePlayerBackend({ playerUrl: 'http://elsewhere', playerUser: 'me', playerPassword: sealSecret('q', secret) }, secret, env);
    expect(b).toMatchObject({ managed: 'bundled', key: 'bundled', server: { url: 'http://player:4533', password: 'p' } });
  });

  it('opens a saved server password with APP_SECRET', () => {
    const b = resolvePlayerBackend({ playerUrl: 'http://nd.lan:4533', playerUser: 'me', playerPassword: sealSecret('hunter2', secret) }, secret, {});
    expect(b).toMatchObject({ managed: 'external', server: { password: 'hunter2', username: 'me' } });
    expect(b!.key).toBe(playerServerKey('external', { url: 'http://nd.lan:4533/', username: 'me' }));
    expect(b!.key).not.toBe(playerServerKey('external', { url: 'http://nd.lan:4533', username: 'other' }));
  });

  it('is null when nothing is configured', () => {
    expect(resolvePlayerBackend({}, secret, { TAGAVE_PLAYER_URL: '' })).toBeNull();
  });
});
