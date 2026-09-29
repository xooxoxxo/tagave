import { describe, it, expect, vi } from 'vitest';
import type { CanonicalRelease, Edition, EditionsPage } from '@liner/core';
import { formatsLabel, rankEditions, resolvePinnedMb, MAX_RELEASE_CHOICES } from './pinnedMb.js';

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

const ed = (mbid: string, media: Array<[string, number]>, extra: Partial<Edition> = {}): Edition => ({
  mbid,
  title: 'Hôtel Costes, Volume 11',
  labels: [],
  media: media.map(([format, trackCount], i) => ({ position: i + 1, format, trackCount })),
  ...extra,
});

// The release group the owner pasted on 2026-09-29 (as MusicBrainz lists it).
const HOTEL_COSTES: EditionsPage = {
  releaseGroup: { mbid: '593f3c1a-3529-39e6-92ef-395dd48f840c', title: 'Hôtel Costes, Volume 11' },
  editions: [
    ed('98d8f63c-c286-4300-82c7-187069479564', [['Digital Media', 18]], { date: '2006', country: 'XW', status: 'Official' }),
    ed('c51fb8f9-9536-4aed-b423-940d74187ade', [['CD', 17]], { date: '2008-09', country: 'FR', status: 'Official' }),
    ed('f52cf3d9-c1f2-492f-99d5-b4b2cbd5d081', [['CD', 16]], { date: '2008', country: 'US', status: 'Official', labels: [{ name: 'Wagram', catalogNumber: '3133172' }] }),
  ],
  total: 3,
  offset: 0,
};

const release = { id: 'r1', title: 'Some Release', tracks: [], artists: [], source: 'musicbrainz' } as unknown as CanonicalRelease;

describe('formatsLabel', () => {
  it('counts repeated media and shortens digital', () => {
    expect(formatsLabel([{ position: 1, format: 'CD' }, { position: 2, format: 'CD' }])).toBe('2×CD');
    expect(formatsLabel([{ position: 1, format: 'CD' }, { position: 2, format: 'DVD-Video' }])).toBe('CD + DVD-Video');
    expect(formatsLabel([{ position: 1, format: 'Digital Media' }])).toBe('Digital');
    expect(formatsLabel([])).toBeUndefined();
  });
});

describe('rankEditions', () => {
  it('puts the release with the local track count first and marks the fit', () => {
    const ranked = rankEditions(HOTEL_COSTES.editions, { trackCount: 16, discCount: 1, year: 2006 });
    expect(ranked.map((c) => c.mbid)).toEqual([
      'f52cf3d9-c1f2-492f-99d5-b4b2cbd5d081',
      'c51fb8f9-9536-4aed-b423-940d74187ade',
      '98d8f63c-c286-4300-82c7-187069479564',
    ]);
    expect(ranked.map((c) => c.fit)).toEqual(['exact', 'close', 'close']);
    expect(ranked[0]).toMatchObject({ trackCount: 16, trackDelta: 0, formats: 'CD', label: 'Wagram', catalogNumber: '3133172', mediumCount: 1 });
    expect(ranked[2]!.trackDelta).toBe(2);
  });

  it('prefers the disc count the files name, and official releases', () => {
    const editions = [
      ed('one-disc', [['CD', 20]], { status: 'Official' }),
      ed('two-disc', [['CD', 10], ['CD', 10]], { status: 'Official' }),
      ed('two-disc-bootleg', [['CD', 10], ['CD', 10]], { status: 'Bootleg' }),
    ];
    const ranked = rankEditions(editions, { trackCount: 20, discCount: 2 });
    expect(ranked.map((c) => c.mbid)).toEqual(['two-disc', 'two-disc-bootleg', 'one-disc']);
    expect(ranked[0]!.fit).toBe('exact');
    expect(ranked[2]!.fit).toBe('close'); // same tracks, wrong disc count
  });

  it('ranks a release with no track count last', () => {
    const ranked = rankEditions([ed('none', []), ed('far', [['CD', 30]])], { trackCount: 12 });
    expect(ranked.map((c) => [c.mbid, c.fit, c.trackDelta])).toEqual([['far', 'far', 18], ['none', 'far', null]]);
  });
});

describe('resolvePinnedMb (mocked MusicBrainz)', () => {
  const local = { trackCount: 16 };

  it('returns the release when the id is a release', async () => {
    const deps = { release: vi.fn().mockResolvedValue(release), releaseGroupEditions: vi.fn() };
    await expect(resolvePinnedMb(deps, { mbid: 'r1' }, local)).resolves.toEqual({ kind: 'release', release });
    expect(deps.releaseGroupEditions).not.toHaveBeenCalled();
  });

  it('falls back to the release group when no release has the id, and lists its releases', async () => {
    const deps = { release: vi.fn().mockRejectedValue(notFound()), releaseGroupEditions: vi.fn().mockResolvedValue(HOTEL_COSTES) };
    const r = await resolvePinnedMb(deps, { mbid: '593f3c1a-3529-39e6-92ef-395dd48f840c' }, local);
    expect(deps.releaseGroupEditions).toHaveBeenCalledWith('593f3c1a-3529-39e6-92ef-395dd48f840c');
    expect(r.kind).toBe('release_group');
    if (r.kind !== 'release_group') return;
    expect(r.releaseGroup).toEqual({ mbid: '593f3c1a-3529-39e6-92ef-395dd48f840c', title: 'Hôtel Costes, Volume 11' });
    expect(r.choices[0]!.mbid).toBe('f52cf3d9-c1f2-492f-99d5-b4b2cbd5d081');
    expect(r.moreChoices).toBe(0);
  });

  it('says the id does not exist when it is neither a release nor a release group', async () => {
    const deps = { release: vi.fn().mockRejectedValue(notFound()), releaseGroupEditions: vi.fn().mockRejectedValue(notFound()) };
    const r = await resolvePinnedMb(deps, { mbid: 'nope' }, local);
    expect(r).toMatchObject({ kind: 'not_found' });
    if (r.kind === 'not_found') expect(r.message).toMatch(/does not exist on MusicBrainz/);
  });

  it('goes straight to the release group for a release-group URL', async () => {
    const deps = { release: vi.fn(), releaseGroupEditions: vi.fn().mockResolvedValue(HOTEL_COSTES) };
    const r = await resolvePinnedMb(deps, { releaseGroup: 'rg' }, local);
    expect(deps.release).not.toHaveBeenCalled();
    expect(r.kind).toBe('release_group');
  });

  it('caps the listed choices and counts the rest', async () => {
    const many: EditionsPage = {
      releaseGroup: { mbid: 'rg', title: 'Big' },
      editions: Array.from({ length: 30 }, (_, i) => ed(`e${i}`, [['CD', 10 + i]])),
      total: 140,
      offset: 0,
    };
    const deps = { release: vi.fn(), releaseGroupEditions: vi.fn().mockResolvedValue(many) };
    const r = await resolvePinnedMb(deps, { releaseGroup: 'rg' }, { trackCount: 10 });
    if (r.kind !== 'release_group') throw new Error('expected a release group');
    expect(r.choices).toHaveLength(MAX_RELEASE_CHOICES);
    expect(r.moreChoices).toBe(140 - MAX_RELEASE_CHOICES);
  });

  it('lets other provider errors through so the job retries', async () => {
    const busy = Object.assign(new Error('MusicBrainz rate limited (503)'), { status: 503 });
    const deps = { release: vi.fn().mockRejectedValue(busy), releaseGroupEditions: vi.fn() };
    await expect(resolvePinnedMb(deps, { mbid: 'x' }, local)).rejects.toThrow(/rate limited/);
  });
});
