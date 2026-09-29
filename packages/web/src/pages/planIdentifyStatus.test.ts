import { describe, it, expect } from 'vitest';
import type { IdentifyRequestView } from '@liner/shared';
import type { IdentifyStatusItem } from '../hooks/useIdentifyStatus';
import { identifyLines, planAlbumScope } from './planIdentifyStatus';

const req = (over: Partial<IdentifyRequestView>): IdentifyRequestView => ({
  status: 'done', jobId: 'j', kind: 'reidentify', pinned: null, createdAt: null, startedAt: null, jobsAhead: 0, outcome: null, ...over,
});
const album = (albumId: string, state: string, request: IdentifyRequestView | null): IdentifyStatusItem => ({
  albumId, exists: true, title: 'Hotel Costes Vol. 11', artist: 'Stéphane Pompougnac', state, reason: null, request,
});

describe('identifyLines', () => {
  it('says what really happened to each request', () => {
    const lines = identifyLines([
      album('a', 'unidentified', req({ status: 'queued', jobsAhead: 0 })),
      album('b', 'unidentified', req({ status: 'running' })),
      album('c', 'matched', req({ outcome: { kind: 'matched', message: 'Matched to X.', finishedAt: '2026-09-29T00:00:00Z' } })),
      album('d', 'unidentified', req({ outcome: { kind: 'unidentified', message: 'Could not be matched: the closest releases differ too much from your files.', finishedAt: '2026-09-29T00:00:00Z' } })),
      album('e', 'unidentified', null),
      { albumId: 'f', exists: false },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['live', 'live', 'matched', 'ended', 'untouched', 'gone']);
    expect(lines[0]).toMatchObject({ text: 'identification queued, next in line', label: 'Stéphane Pompougnac — Hotel Costes Vol. 11' });
    expect(lines[1]).toMatchObject({ text: 'identifying now' });
    expect(lines[3]).toMatchObject({ title: 'could not be matched', actionable: true });
  });

  it('an album matched by other means reads as matched even with an older failed request', () => {
    const [l] = identifyLines([album('a', 'matched', req({ outcome: { kind: 'failed', message: 'x', finishedAt: '2026-09-29T00:00:00Z' } }))]);
    expect(l!.kind).toBe('matched');
  });
});

describe('planAlbumScope', () => {
  it('counts plan albums merged away since the plan was made', () => {
    const items: IdentifyStatusItem[] = [album('keep', 'unidentified', null), { albumId: 'merged', exists: false }];
    expect(planAlbumScope(['merged', 'keep'], items)).toEqual({ made: 2, gone: 1, now: 1 });
  });
  it('is null without an album scope or before the status loads', () => {
    expect(planAlbumScope(null, [])).toBeNull();
    expect(planAlbumScope(['a'], undefined)).toBeNull();
  });
});
