/**
 * The album page's request state comes from the live job, then the recorded
 * outcome, then the pg-boss end state — never a stale "queued".
 */
import { describe, it, expect } from 'vitest';
import { classifyIdentifyJob, deriveIdentifyRequest, type IdentifyJobRow, type IdentifyRunRow, type PendingIdentify } from './identifyRequests.js';

const RG = '593f3c1a-3529-39e6-92ef-395dd48f840c';
const job = (over: Partial<IdentifyJobRow> = {}): IdentifyJobRow => ({
  id: 'job-1',
  state: 'completed',
  data: { localAlbumId: 'a', force: true, pinnedMbid: RG },
  output: null,
  created_on: '2026-09-29T15:52:19.000Z',
  completed_on: '2026-09-29T15:52:20.000Z',
  ...over,
});
const run = (over: Partial<IdentifyRunRow> = {}): IdentifyRunRow => ({
  job_id: 'job-1',
  kind: 'mbid',
  pinned: RG,
  outcome: 'release_group',
  message: 'No MusicBrainz release has this ID. It is a release group — pick one of its releases:',
  detail: { releaseGroup: { mbid: RG, title: 'Hôtel Costes, Volume 11' }, choices: [{ mbid: 'r', title: 'Hôtel Costes, Volume 11', trackCount: 16, mediumCount: 1, trackDelta: 0, fit: 'exact' }], moreChoices: 2 },
  finished_at: '2026-09-29T15:52:20.300Z',
  ...over,
});
const pending = (state: PendingIdentify['state'], jobsAhead = 0): PendingIdentify => ({
  id: 'job-2', state, kind: 'mbid', pinned: RG, priority: 100,
  createdAt: '2026-09-29T16:00:00.000Z', startedAt: state === 'active' ? '2026-09-29T16:00:01.000Z' : null, jobsAhead,
});

describe('deriveIdentifyRequest', () => {
  it('a live job wins: queued, running or retrying, with no outcome yet', () => {
    expect(deriveIdentifyRequest(pending('created', 3), job(), run())).toMatchObject({ status: 'queued', jobId: 'job-2', jobsAhead: 3, outcome: null });
    expect(deriveIdentifyRequest(pending('active', 3), null, null)).toMatchObject({ status: 'running', jobsAhead: 0 });
    expect(deriveIdentifyRequest(pending('retry'), null, null)).toMatchObject({ status: 'retrying' });
  });

  it('a finished job reads the outcome the worker recorded, with its release choices', () => {
    const v = deriveIdentifyRequest(null, job(), run());
    expect(v).toMatchObject({ status: 'done', jobId: 'job-1', kind: 'mbid', pinned: RG, createdAt: '2026-09-29T15:52:19.000Z' });
    expect(v!.outcome).toMatchObject({ kind: 'release_group', releaseGroup: { title: 'Hôtel Costes, Volume 11' }, moreChoices: 2 });
    expect(v!.outcome!.choices).toHaveLength(1);
  });

  it('a job that ended before outcomes were recorded says so instead of "queued"', () => {
    const v = deriveIdentifyRequest(null, job(), null);
    expect(v).toMatchObject({ status: 'done', kind: 'mbid', outcome: { kind: 'unknown', finishedAt: '2026-09-29T15:52:20.000Z' } });
  });

  it('an older outcome does not describe a newer job', () => {
    const newer = job({ id: 'job-3', created_on: '2026-09-30T10:00:00.000Z', completed_on: '2026-09-30T10:00:05.000Z' });
    expect(deriveIdentifyRequest(null, newer, run())!.outcome!.kind).toBe('unknown');
  });

  it('pg-boss failures and cancellations without a row still read plainly', () => {
    expect(deriveIdentifyRequest(null, job({ state: 'failed', output: { message: 'MusicBrainz rate limited (503)' } }), null)!.outcome)
      .toMatchObject({ kind: 'failed', message: 'The lookup failed: MusicBrainz rate limited (503)' });
    expect(deriveIdentifyRequest(null, job({ state: 'cancelled' }), null)!.outcome!.kind).toBe('cancelled');
  });

  it('an outcome recorded by the API (cancel) with no job row still shows', () => {
    expect(deriveIdentifyRequest(null, null, run({ outcome: 'cancelled', message: 'You cancelled this request before it ran.', detail: null })))
      .toMatchObject({ status: 'done', outcome: { kind: 'cancelled' } });
  });

  it('an unknown outcome string degrades to unknown', () => {
    expect(deriveIdentifyRequest(null, null, run({ outcome: 'weird' }))!.outcome!.kind).toBe('unknown');
  });

  it('nothing ever requested: null', () => {
    expect(deriveIdentifyRequest(null, null, null)).toBeNull();
  });
});

describe('classifyIdentifyJob', () => {
  it('recognises a release-group request', () => {
    expect(classifyIdentifyJob({ force: true, pinnedReleaseGroup: RG })).toEqual({ kind: 'release_group', pinned: RG });
  });
});
