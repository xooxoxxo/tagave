import { describe, expect, it } from 'vitest';
import { LISTENBRAINZ_SIMILAR_ALGORITHM, SimilarArtistsClient, mergeSimilar, similarDue, similarNameKey, type SimilarHit } from './index.js';

const RH = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const NIRVANA = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const MUSE = '9c9f1380-2516-4fc9-a3e6-f9f61941d090';
const BJORK = '87c5dedd-371d-4a53-9f7f-80522fb7f3cb';

function fake(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; ua: string | null }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get('user-agent') });
    const key = Object.keys(answers).find((k) => url.includes(k));
    const a = key ? answers[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('ListenBrainz', () => {
  it('asks by MBID with the algorithm and the UA; scales scores by the best one', async () => {
    const { calls, fetchImpl } = fake({
      'labs.test': { body: [
        { artist_mbid: NIRVANA, name: 'Nirvana', comment: 'US grunge band', type: 'Group', score: 200, reference_mbid: RH },
        { artist_mbid: MUSE, name: 'Muse', comment: '', score: 100, reference_mbid: RH },
        { artist_mbid: RH, name: 'Radiohead', comment: '', score: 300, reference_mbid: RH },
        { artist_mbid: 'not-an-mbid', name: 'Junk', score: 50 },
      ] },
    });
    const c = new SimilarArtistsClient({ userAgent: 'tagave/0.1 (+example.com)', fetchImpl, listenbrainzUrl: 'https://labs.test/similar-artists/json' });
    const hits = await c.listenbrainz(RH);
    expect(hits).toEqual([
      { mbid: NIRVANA, name: 'Nirvana', comment: 'US grunge band', score: 1 },
      { mbid: MUSE, name: 'Muse', comment: null, score: 0.5 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ua).toBe('tagave/0.1 (+example.com)');
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('artist_mbids')).toBe(RH);
    expect(u.searchParams.get('algorithm')).toBe(LISTENBRAINZ_SIMILAR_ALGORITHM);
    // only the MBID and the algorithm leave
    expect([...u.searchParams.keys()].sort()).toEqual(['algorithm', 'artist_mbids']);
  });

  it('an unknown artist is an empty list; a rate limit or an outage throws', async () => {
    const lb = (status: number) => new SimilarArtistsClient({ userAgent: 'ua', fetchImpl: fake({ 'labs.test': { status, body: {} } }).fetchImpl, listenbrainzUrl: 'https://labs.test/x' });
    expect(await lb(404).listenbrainz(RH)).toEqual([]);
    expect(await lb(400).listenbrainz(RH)).toEqual([]);
    await expect(lb(429).listenbrainz(RH)).rejects.toThrow(/429/);
    await expect(lb(503).listenbrainz(RH)).rejects.toThrow(/503/);
    // not an MBID: nothing is asked
    const { calls, fetchImpl } = fake({});
    expect(await new SimilarArtistsClient({ userAgent: 'ua', fetchImpl }).listenbrainz('nope')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runs every call through the pacer', async () => {
    const paced: string[] = [];
    const c = new SimilarArtistsClient({
      userAgent: 'ua', fetchImpl: fake({ 'labs.test': { body: [] }, 'fm.test': { body: { similarartists: { artist: [] } } } }).fetchImpl,
      listenbrainzUrl: 'https://labs.test/x', lastfmUrl: 'https://fm.test/2.0/',
      pace: (p, fn) => { paced.push(p); return fn(); },
    });
    await c.listenbrainz(RH);
    await c.lastfm(RH, 'key');
    expect(paced).toEqual(['listenbrainz', 'lastfm']);
  });
});

describe('Last.fm', () => {
  it('asks artist.getSimilar by MBID; an artist without an MBID keeps its name', async () => {
    const { calls, fetchImpl } = fake({
      'fm.test': { body: { similarartists: { artist: [
        { name: 'Muse', mbid: MUSE, match: '1' },
        { name: 'Thom Yorke', mbid: '', match: '0.8' },
        { name: 'Zero', mbid: '', match: '0' },
      ] } } },
    });
    const c = new SimilarArtistsClient({ userAgent: 'ua', fetchImpl, lastfmUrl: 'https://fm.test/2.0/' });
    expect(await c.lastfm(RH, 'k123')).toEqual([
      { mbid: MUSE, name: 'Muse', comment: null, score: 1 },
      { mbid: null, name: 'Thom Yorke', comment: null, score: 0.8 },
    ]);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('method')).toBe('artist.getsimilar');
    expect(u.searchParams.get('mbid')).toBe(RH);
    expect(u.searchParams.get('api_key')).toBe('k123');
    expect(u.searchParams.has('artist')).toBe(false);
  });

  it('error 6 (not known) is empty; error 29 is a rate limit', async () => {
    const fm = (body: unknown) => new SimilarArtistsClient({ userAgent: 'ua', fetchImpl: fake({ 'fm.test': { body } }).fetchImpl, lastfmUrl: 'https://fm.test/' });
    expect(await fm({ error: 6, message: 'The artist you supplied could not be found' }).lastfm(RH, 'k')).toEqual([]);
    await expect(fm({ error: 29, message: 'Rate limit' }).lastfm(RH, 'k')).rejects.toThrow(/429/);
    await expect(fm({ error: 10, message: 'Invalid API key' }).lastfm(RH, 'k')).rejects.toThrow(/error 10/);
  });
});

describe('merging', () => {
  const lb: SimilarHit[] = [
    { mbid: NIRVANA, name: 'Nirvana', comment: 'US grunge band', score: 1 },
    { mbid: MUSE, name: 'Muse', comment: 'UK rock band', score: 0.5 },
  ];
  it('ListenBrainz alone: its own order and scores', () => {
    expect(mergeSimilar(lb, null)).toEqual([
      { mbid: NIRVANA, name: 'Nirvana', comment: 'US grunge band', score: 1, sources: ['listenbrainz'] },
      { mbid: MUSE, name: 'Muse', comment: 'UK rock band', score: 0.5, sources: ['listenbrainz'] },
    ]);
  });

  it('by MBID, else by name; the scores blend 0.6 / 0.4', () => {
    const fm: SimilarHit[] = [
      { mbid: MUSE, name: 'MUSE', comment: null, score: 1 },
      { mbid: null, name: 'Björk', comment: null, score: 0.5 },
      { mbid: null, name: 'nirvana', comment: null, score: 0.5 },
    ];
    const out = mergeSimilar(lb, fm);
    expect(out).toEqual([
      { mbid: NIRVANA, name: 'Nirvana', comment: 'US grunge band', score: 0.8, sources: ['lastfm', 'listenbrainz'] },
      { mbid: MUSE, name: 'Muse', comment: 'UK rock band', score: 0.7, sources: ['lastfm', 'listenbrainz'] },
      { mbid: null, name: 'Björk', comment: null, score: 0.2, sources: ['lastfm'] },
    ]);
  });

  it('a name match with another MBID is another artist; the artist itself and the limit', () => {
    const fm: SimilarHit[] = [{ mbid: BJORK, name: 'Nirvana', comment: null, score: 1 }, { mbid: null, name: 'Radiohead', comment: null, score: 1 }];
    const out = mergeSimilar(lb, fm, { exclude: { mbid: RH, name: 'Radiohead' } });
    expect(out.map((m) => m.mbid)).toEqual([NIRVANA, BJORK, MUSE]);
    expect(mergeSimilar(lb, null, { limit: 1 })).toHaveLength(1);
  });

  it('names match without accents, case, punctuation or a leading The', () => {
    expect(similarNameKey('The Beatles')).toBe(similarNameKey('beatles'));
    expect(similarNameKey('Björk')).toBe(similarNameKey('Bjork'));
    expect(similarNameKey('Simon & Garfunkel')).toBe(similarNameKey('Simon and Garfunkel'));
    expect(similarNameKey('坂本龍一')).toBe('坂本龍一');
  });
});

describe('when to fetch again', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('never fetched, a week old, or failed a day ago', () => {
    expect(similarDue(null, now)).toBe(true);
    expect(similarDue({ fetchedAt: new Date(now - 6 * 86_400_000) }, now)).toBe(false);
    expect(similarDue({ fetchedAt: new Date(now - 8 * 86_400_000) }, now)).toBe(true);
    expect(similarDue({ fetchedAt: new Date(now - 2 * 3_600_000), error: 'x' }, now)).toBe(false);
    expect(similarDue({ fetchedAt: new Date(now - 2 * 86_400_000), error: 'x' }, now)).toBe(true);
  });
});
