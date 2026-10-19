import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { heardEnough, retryDelayMs, scrobbleWorthy } from './rules.js';
import { lastfmAuthorizeUrl, lastfmScrobble, lastfmScrobbleBatch, lastfmSignature } from './lastfm.js';
import { listenbrainzScrobble, listenbrainzScrobbleBatch } from './listenbrainz.js';
import { freePlayerUserName, playerUserName } from '../player/navidrome.js';

describe('when a play counts', () => {
  it('follows Last.fm: longer than 30 s, and half of it or four minutes heard', () => {
    expect(scrobbleWorthy(100_000, 200_000)).toBe(true);
    expect(scrobbleWorthy(99_999, 200_000)).toBe(false);
    expect(scrobbleWorthy(240_000, 1_200_000)).toBe(true);
    expect(scrobbleWorthy(30_000, 30_000)).toBe(false);
    expect(scrobbleWorthy(20_000, 31_000)).toBe(true);
    expect(scrobbleWorthy(10_000, null)).toBe(false);
  });
  it('counts a short interlude towards an album listen', () => {
    expect(heardEnough(15_000, 25_000)).toBe(true);
    expect(scrobbleWorthy(15_000, 25_000)).toBe(false);
  });
  it('backs off from a minute up to six hours', () => {
    expect([1, 2, 3, 10, 30].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 21_600_000, 21_600_000]);
  });
});

describe('Last.fm', () => {
  it('signs the sorted parameters with the secret, leaving out format', () => {
    const p = { method: 'track.scrobble', artist: 'A', track: 'T', api_key: 'k', sk: 's', timestamp: '1' };
    const want = createHash('md5').update('api_keyk' + 'artistA' + 'methodtrack.scrobble' + 'sks' + 'timestamp1' + 'trackT' + 'SECRET').digest('hex');
    expect(lastfmSignature({ ...p, format: 'json' }, 'SECRET')).toBe(want);
  });
  it('sends the browser to Last.fm with the callback', () => {
    const url = new URL(lastfmAuthorizeUrl({ apiKey: 'KEY', secret: 'S' }, 'https://tagave.example/cb?state=x'));
    expect(url.origin + url.pathname).toBe('https://www.last.fm/api/auth/');
    expect(url.searchParams.get('cb')).toBe('https://tagave.example/cb?state=x');
  });
  it('tells a dead session, an outage and an ignored scrobble apart', async () => {
    const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const app = { apiKey: 'k', secret: 's', apiUrl: 'http://x/' };
    const track = { artist: 'A', track: 'T', album: null, albumArtist: null, trackNumber: null, durationMs: 200_000, recordingMbid: null, releaseMbid: null };
    expect((await lastfmScrobble(app, 'sk', track, new Date(), { fetchImpl: answer({ error: 9, message: 'Invalid session key' }) })).kind).toBe('auth');
    expect((await lastfmScrobble(app, 'sk', track, new Date(), { fetchImpl: answer({ error: 11, message: 'Offline' }) })).kind).toBe('retry');
    expect(await lastfmScrobble(app, 'sk', track, new Date(), { fetchImpl: answer({ scrobbles: { '@attr': { accepted: 0, ignored: 1 }, scrobble: { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } } } }) })).toEqual({ kind: 'ignored', reason: 'Timestamp too old' });
    expect((await lastfmScrobble(app, 'sk', track, new Date(), { fetchImpl: answer({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }) })).kind).toBe('sent');
  });
});

describe('batches', () => {
  const track = (t: string) => ({ artist: 'A', track: t, album: null, albumArtist: null, trackNumber: null, durationMs: 200_000, recordingMbid: null, releaseMbid: null });
  const items = [track('One'), track('Two'), track('Three')].map((t, i) => ({ track: t, startedAt: new Date((1000 + i) * 1000) }));
  it('sends Last.fm scrobbles as one indexed call, with an outcome per item', async () => {
    let form: URLSearchParams | null = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      form = new URLSearchParams(String(init.body));
      return new Response(JSON.stringify({ scrobbles: { '@attr': { accepted: 2, ignored: 1 }, scrobble: [
        { ignoredMessage: { code: '0', '#text': '' } }, { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } }, { ignoredMessage: { code: '0', '#text': '' } },
      ] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await lastfmScrobbleBatch({ apiKey: 'k', secret: 's', apiUrl: 'http://x/' }, 'sk', items, { fetchImpl });
    expect(out).toEqual([{ kind: 'sent' }, { kind: 'ignored', reason: 'Timestamp too old' }, { kind: 'sent' }]);
    expect(form!.get('track[1]')).toBe('Two');
    expect(form!.get('timestamp[2]')).toBe('1002');
    expect(form!.get('track')).toBeNull();
    const busy = (async () => new Response(JSON.stringify({ error: 29, message: 'Rate limit exceeded' }), { status: 200 })) as unknown as typeof fetch;
    expect(await lastfmScrobbleBatch({ apiKey: 'k', secret: 's', apiUrl: 'http://x/' }, 'sk', items, { fetchImpl: busy })).toEqual(items.map(() => ({ kind: 'retry', reason: 'Rate limit exceeded' })));
    await expect(lastfmScrobbleBatch({ apiKey: 'k', secret: 's' }, 'sk', Array.from({ length: 51 }, () => items[0]!))).rejects.toThrow(RangeError);
  });
  it('sends several ListenBrainz listens as one import', async () => {
    let body: any = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('{"status":"ok"}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await listenbrainzScrobbleBatch('tok', items, { fetchImpl })).toEqual({ kind: 'sent' });
    expect(body.listen_type).toBe('import');
    expect(body.payload.map((p: any) => [p.listened_at, p.track_metadata.track_name])).toEqual([[1000, 'One'], [1001, 'Two'], [1002, 'Three']]);
    await listenbrainzScrobbleBatch('tok', items.slice(0, 1), { fetchImpl });
    expect(body.listen_type).toBe('single');
  });
});

describe('ListenBrainz', () => {
  it('sends the recording and release MBIDs and retries on 429', async () => {
    let body: any = null;
    const ok = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('{"status":"ok"}', { status: 200 }); }) as unknown as typeof fetch;
    const track = { artist: 'A', track: 'T', album: 'Al', albumArtist: null, trackNumber: 2, durationMs: 200_000, recordingMbid: 'rec', releaseMbid: 'rel' };
    expect((await listenbrainzScrobble('tok', track, new Date(1_000_000), { fetchImpl: ok })).kind).toBe('sent');
    expect(body).toEqual({ listen_type: 'single', payload: [{ listened_at: 1000, track_metadata: { artist_name: 'A', track_name: 'T', release_name: 'Al', additional_info: { media_player: 'tagave', submission_client: 'tagave', recording_mbid: 'rec', release_mbid: 'rel', duration_ms: 200_000, tracknumber: 2 } } }] });
    const busy = (async () => new Response('{"error":"slow down"}', { status: 429 })) as unknown as typeof fetch;
    expect(await listenbrainzScrobble('tok', track, new Date(), { fetchImpl: busy })).toEqual({ kind: 'retry', reason: 'slow down' });
    const bad = (async () => new Response('{"error":"Invalid authorization token."}', { status: 401 })) as unknown as typeof fetch;
    expect((await listenbrainzScrobble('tok', track, new Date(), { fetchImpl: bad })).kind).toBe('auth');
  });
});

describe('player user names', () => {
  it('derives a safe Navidrome name from the person', () => {
    expect(playerUserName({ displayName: 'Ångström Ödön', email: 'x@y' })).toBe('angstrom-odon');
    expect(playerUserName({ displayName: null, email: 'Oytun.E@example.com' })).toBe('oytun.e');
    expect(playerUserName({ displayName: '  ', email: '@' })).toBe('listener');
    expect(playerUserName({ displayName: 'Admin' })).toBe('admin-person');
    expect(playerUserName({ displayName: '名前' })).toBe('listener');
    expect(playerUserName({ displayName: 'a'.repeat(40) })).toHaveLength(24);
  });
  it('adds a number when the name is taken', () => {
    expect(freePlayerUserName('ben', ['admin'])).toBe('ben');
    expect(freePlayerUserName('ben', ['Ben', 'ben-2'])).toBe('ben-3');
  });
});
