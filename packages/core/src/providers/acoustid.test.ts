import { describe, expect, it } from 'vitest';
import { AcoustIdClient, AcoustIdError, acoustIdResponseSchema, flattenResults, rankReleases } from './acoustid.js';

// Live shape (2026-09-09, meta=recordings releases releasegroups): releases sit INSIDE
// each recording's releasegroups[]; recording.releases is absent or empty. The flat
// shape (meta without releasegroups) is kept in the second result.
const sample = {
  status: 'ok',
  results: [
    {
      id: 'fp-1', score: 0.97,
      recordings: [
        { id: 'rec-a', title: 'Airbag', duration: 284, releases: [], releasegroups: [
          { id: 'rg-ok', type: 'Album', title: 'OK Computer', releases: [
            { id: 'rel-uk', title: 'OK Computer', country: 'GB', track_count: 12, medium_count: 1 },
            { id: 'rel-us', title: 'OK Computer', country: 'US', track_count: 12, medium_count: 1 },
          ] },
          { id: 'rg-comp', type: 'Album', title: 'Some Compilation', releases: [
            { id: 'rel-comp', title: 'Some Compilation', track_count: 40, medium_count: 2 },
          ] },
        ] },
      ],
    },
    { id: 'fp-2', score: 0.41, recordings: [{ id: 'rec-noise', releases: [{ id: 'rel-noise' }] }] },
  ],
};

describe('flattenResults', () => {
  it('yields one row per recording, best score first, with releases lifted out of their release groups', () => {
    const rows = flattenResults(acoustIdResponseSchema.parse(sample));
    expect(rows.map((r) => r.recordingMbid)).toEqual(['rec-a', 'rec-noise']);
    expect(rows[0]!.releases.map((r) => r.mbid)).toEqual(['rel-uk', 'rel-us', 'rel-comp']);
    expect(rows[0]!.releases[0]).toMatchObject({ mbid: 'rel-uk', releaseGroupMbid: 'rg-ok', trackCount: 12, country: 'GB' });
    expect(rows[0]!.releases[2]).toMatchObject({ mbid: 'rel-comp', releaseGroupMbid: 'rg-comp' });
    expect(rows[1]!.releases[0]).toEqual({ mbid: 'rel-noise' });
  });

  it('does not list a release twice when it appears flat and under its group', () => {
    const both = { status: 'ok', results: [{ id: 'x', score: 1, recordings: [{ id: 'r',
      releases: [{ id: 'rel-1', releasegroup: { id: 'rg-1' } }],
      releasegroups: [{ id: 'rg-1', releases: [{ id: 'rel-1' }] }] }] }] };
    expect(flattenResults(acoustIdResponseSchema.parse(both))[0]!.releases).toEqual([{ mbid: 'rel-1', releaseGroupMbid: 'rg-1' }]);
  });

  it('tolerates an empty result list', () => {
    expect(flattenResults(acoustIdResponseSchema.parse({ status: 'ok', results: [] }))).toEqual([]);
  });
});

describe('rankReleases', () => {
  const track = (score: number, ...releases: string[]) => [{ score, recordingMbid: 'r', releases: releases.map((mbid) => ({ mbid })) }];

  it('scores a release by the tracks that point at it and reports coverage', () => {
    const ranked = rankReleases([track(0.9, 'rel-uk', 'rel-comp'), track(0.8, 'rel-uk'), track(0.7, 'rel-comp'), []]);
    expect(ranked[0]).toMatchObject({ mbid: 'rel-uk', tracksMatched: 2, coverage: 2 / 3 });
    expect(ranked[0]!.score).toBeCloseTo(1.7);
    expect(ranked[1]).toMatchObject({ mbid: 'rel-comp', tracksMatched: 2 });
  });

  it('is empty when no track had a lookup', () => {
    expect(rankReleases([[], []])).toEqual([]);
  });
});

describe('AcoustIdClient', () => {
  it('posts the fingerprint as a form and parses the reply', async () => {
    let seen: { url: string; body: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body), headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(sample), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new AcoustIdClient({ apiKey: 'KEY', userAgent: 'Liner/test', fetchImpl });
    const rows = await client.lookup('AQADtImU', 284.6);
    expect(rows).toHaveLength(2);
    const params = new URLSearchParams(seen!.body);
    expect(seen!.url).toBe('https://api.acoustid.org/v2/lookup');
    expect(params.get('client')).toBe('KEY');
    expect(params.get('duration')).toBe('285');
    expect(params.get('fingerprint')).toBe('AQADtImU');
    expect(params.get('meta')).toBe('recordings releases releasegroups');
    expect(seen!.headers['User-Agent']).toBe('Liner/test');
  });

  it('turns 503 and an error status into AcoustIdError with isRateLimit', async () => {
    const busy = (async () => new Response('', { status: 503, statusText: 'busy' })) as unknown as typeof fetch;
    await expect(new AcoustIdClient({ apiKey: 'K', userAgent: 'u', fetchImpl: busy }).lookup('x', 1)).rejects.toMatchObject({ name: 'AcoustIdError', isRateLimit: true });
    const bad = (async () => new Response(JSON.stringify({ status: 'error', error: { code: 4, message: 'invalid API key' } }), { status: 200 })) as unknown as typeof fetch;
    await expect(new AcoustIdClient({ apiKey: 'K', userAgent: 'u', fetchImpl: bad }).lookup('x', 1)).rejects.toThrow(/invalid API key/);
    expect(new AcoustIdError('x', 429).isRateLimit).toBe(true);
  });
});
