import { describe, expect, it } from 'vitest';
import { lastfmLove } from './lastfm.js';
import { listenbrainzFeedback } from './listenbrainz.js';
import { getStarred2, starItems } from '../player/subsonic.js';

type Seen = { url: string; body: string | null; headers: Record<string, string> };

const fake = (seen: Seen[], status: number, body: unknown) => (async (url: string, init?: RequestInit) => {
  seen.push({ url, body: init?.body ? String(init.body) : null, headers: (init?.headers ?? {}) as Record<string, string> });
  return new Response(JSON.stringify(body), { status });
}) as unknown as typeof fetch;

describe('loves', () => {
  const app = { apiKey: 'k', secret: 's', apiUrl: 'http://lastfm.test/' };

  it('Last.fm: track.love and track.unlove, signed, with the session key', async () => {
    const seen: Seen[] = [];
    expect(await lastfmLove(app, 'sk1', { artist: 'Miles Davis', track: 'So What' }, true, { fetchImpl: fake(seen, 200, {}) })).toEqual({ kind: 'sent' });
    expect(await lastfmLove(app, 'sk1', { artist: 'Miles Davis', track: 'So What' }, false, { fetchImpl: fake(seen, 200, {}) })).toEqual({ kind: 'sent' });
    const [love, unlove] = seen.map((s) => new URLSearchParams(s.body!));
    expect(love!.get('method')).toBe('track.love');
    expect(unlove!.get('method')).toBe('track.unlove');
    expect(love!.get('sk')).toBe('sk1');
    expect(love!.get('artist')).toBe('Miles Davis');
    expect(love!.get('track')).toBe('So What');
    expect(love!.get('api_sig')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Last.fm: a dead session waits for the person, an outage retries', async () => {
    expect((await lastfmLove(app, 'sk', { artist: 'A', track: 'T' }, true, { fetchImpl: fake([], 200, { error: 9, message: 'Invalid session key' }) })).kind).toBe('auth');
    expect((await lastfmLove(app, 'sk', { artist: 'A', track: 'T' }, true, { fetchImpl: fake([], 503, null) })).kind).toBe('retry');
  });

  it('ListenBrainz: recording feedback, score 1 to love and 0 to take it back', async () => {
    const seen: Seen[] = [];
    const mbid = '5c3f6e1a-0000-4000-8000-000000000001';
    expect(await listenbrainzFeedback('tok', mbid, true, { apiUrl: 'http://lb.test', fetchImpl: fake(seen, 200, { status: 'ok' }) })).toEqual({ kind: 'sent' });
    expect(await listenbrainzFeedback('tok', mbid, false, { apiUrl: 'http://lb.test', fetchImpl: fake(seen, 200, { status: 'ok' }) })).toEqual({ kind: 'sent' });
    expect(seen[0]!.url).toBe('http://lb.test/1/feedback/recording-feedback');
    expect(seen[0]!.headers['authorization']).toBe('Token tok');
    expect(JSON.parse(seen[0]!.body!)).toEqual({ recording_mbid: mbid, score: 1 });
    expect(JSON.parse(seen[1]!.body!)).toEqual({ recording_mbid: mbid, score: 0 });
  });

  it('ListenBrainz: a song without a recording MBID is not sent', async () => {
    const seen: Seen[] = [];
    expect((await listenbrainzFeedback('tok', null, true, { fetchImpl: fake(seen, 200, {}) })).kind).toBe('ignored');
    expect(seen).toHaveLength(0);
  });
});

describe('Subsonic stars', () => {
  const server = { url: 'http://player.test', username: 'anna', password: 'pw' };
  it('reads getStarred2 with when each was starred', async () => {
    const seen: Seen[] = [];
    const r = await getStarred2(server, { fetchImpl: fake(seen, 200, { 'subsonic-response': { status: 'ok', starred2: {
      song: [{ id: 's1', title: 'So What', starred: '2026-11-01T10:00:00Z', musicBrainzId: 'rec-1' }],
      album: [{ id: 'al1', name: 'Kind of Blue', artistId: 'ar1', starred: '2026-11-02T10:00:00Z' }],
      artist: [{ id: 'ar1', name: 'Miles Davis', musicBrainzId: 'mb-1', starred: '2026-11-03T10:00:00Z' }],
    } } }) });
    expect(new URL(seen[0]!.url).pathname).toBe('/rest/getStarred2');
    expect(r.songs[0]).toMatchObject({ id: 's1', starred: '2026-11-01T10:00:00Z', musicBrainzId: 'rec-1' });
    expect(r.albums[0]).toMatchObject({ id: 'al1', artistId: 'ar1', starred: '2026-11-02T10:00:00Z' });
    expect(r.artists[0]).toEqual({ id: 'ar1', name: 'Miles Davis', musicBrainzId: 'mb-1', starred: '2026-11-03T10:00:00Z' });
  });

  it('stars songs by id, albums by albumId and artists by artistId', async () => {
    const seen: Seen[] = [];
    const ok = fake(seen, 200, { 'subsonic-response': { status: 'ok' } });
    await starItems(server, 'song', ['s1', 's2'], true, { fetchImpl: ok });
    await starItems(server, 'album', ['al1'], false, { fetchImpl: ok });
    await starItems(server, 'artist', ['ar1'], true, { fetchImpl: ok });
    await starItems(server, 'song', [], true, { fetchImpl: ok });
    const urls = seen.map((s) => new URL(s.url));
    expect(urls).toHaveLength(3);
    expect(urls[0]!.pathname).toBe('/rest/star');
    expect(urls[0]!.searchParams.getAll('id')).toEqual(['s1', 's2']);
    expect(urls[1]!.pathname).toBe('/rest/unstar');
    expect(urls[1]!.searchParams.get('albumId')).toBe('al1');
    expect(urls[2]!.searchParams.get('artistId')).toBe('ar1');
  });
});
