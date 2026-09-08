import { describe, it, expect } from 'vitest';
import { classifyIdentifyJob, jobsAheadOf, IDENTIFY_PRIORITY } from './identifyRequests.js';

describe('classifyIdentifyJob', () => {
  it('recognises a pinned MusicBrainz id', () => {
    expect(classifyIdentifyJob({ localAlbumId: 'a', force: true, pinnedMbid: '2a48e55e-5876-4477-8b53-44474b7f9a35' }))
      .toEqual({ kind: 'mbid', pinned: '2a48e55e-5876-4477-8b53-44474b7f9a35' });
  });
  it('recognises a pinned Discogs release or master', () => {
    expect(classifyIdentifyJob({ pinnedDiscogs: { kind: 'master', id: 358698 } })).toEqual({ kind: 'discogs', pinned: 'master:358698' });
    expect(classifyIdentifyJob({ pinnedDiscogs: { id: 15803887 } })).toEqual({ kind: 'discogs', pinned: 'release:15803887' });
  });
  it('distinguishes a forced re-identify from the sweep', () => {
    expect(classifyIdentifyJob({ localAlbumId: 'a', force: true })).toEqual({ kind: 'reidentify', pinned: null });
    expect(classifyIdentifyJob({ localAlbumId: 'a' })).toEqual({ kind: 'sweep', pinned: null });
    expect(classifyIdentifyJob(null)).toEqual({ kind: 'sweep', pinned: null });
  });
});

describe('jobsAheadOf', () => {
  const t = (n: number) => 1_700_000_000_000 + n;
  it('counts higher-priority jobs and earlier same-priority jobs only', () => {
    const me = { priority: IDENTIFY_PRIORITY.manual, createdAt: t(10) };
    const others = [
      { priority: 0, createdAt: t(1) },      // sweep job, older but lower priority → behind me
      { priority: 100, createdAt: t(5) },    // earlier manual → ahead
      { priority: 100, createdAt: t(20) },   // later manual → behind
      { priority: 200, createdAt: t(30) },   // higher priority → ahead even though newer
    ];
    expect(jobsAheadOf(me, others)).toBe(2);
  });
  it('a sweep job waits behind every manual request', () => {
    const sweep = { priority: 0, createdAt: t(0) };
    expect(jobsAheadOf(sweep, [{ priority: 100, createdAt: t(99) }, { priority: 0, createdAt: t(1) }])).toBe(1);
  });
});
