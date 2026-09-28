import { describe, it, expect } from 'vitest';
import type { JobView } from '@liner/shared';
import { deriveJobViews, jobLabel, jobSummary, parseProgress, retryRequest, summarizeJobs, toIso, type JobRow } from './jobView.js';

const LIB = '01a05c38-c7d3-7d58-b32a-0f0ecc428e64';
const ROOT = 'bd4393e4-681f-438d-83da-69253bad8806';
const NOW = Date.parse('2026-09-28T18:00:00Z');
const h = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

let seq = 0;
function row(over: Partial<JobRow>): JobRow {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'scan.root', subjectType: 'scan_root', subjectId: ROOT, state: 'completed',
    progress: { done: 0, total: 0 }, startedAt: null, finishedAt: null, error: null,
    createdAt: h(1), subjectName: 'Music',
    ...over,
  };
}
/** rows newest first, like the route loads them */
const views = (rows: JobRow[]) => deriveJobViews(rows, LIB, NOW);

describe('toIso', () => {
  it('accepts Dates and the strings raw client queries return', () => {
    expect(toIso(new Date('2026-09-28T12:00:00Z'))).toBe('2026-09-28T12:00:00.000Z');
    expect(toIso('2026-09-28 12:00:00+00')).toBe('2026-09-28T12:00:00.000Z');
    expect(toIso(null)).toBeNull();
    expect(toIso('not a date')).toBeNull();
  });
});

describe('parseProgress', () => {
  it('reads jsonb objects and legacy strings, and zeroes anything else', () => {
    expect(parseProgress({ done: 3, total: 9, message: 'x' })).toEqual({ done: 3, total: 9, message: 'x' });
    expect(parseProgress('{"done":1,"total":2}')).toEqual({ done: 1, total: 2, message: null });
    expect(parseProgress(null)).toEqual({ done: 0, total: 0, message: null });
    expect(parseProgress({ done: 'x' })).toEqual({ done: 0, total: 0, message: null });
  });
});

describe('jobLabel', () => {
  it('names the work in plain words and never leaks an internal type', () => {
    expect(jobLabel('scan.root', 'Music')).toBe('Scan Music');
    expect(jobLabel('identify.sweep')).toBe('Identify albums');
    expect(jobLabel('some.future.job')).toBe('Background task');
  });
});

describe('jobSummary', () => {
  it('turns a scan result into a sentence', () => {
    const p = parseProgress({ done: 241516, total: 241516, message: 'quick: 241516 seen, 0 added, 0 changed, 0 missing, 72502/72502 dirs skipped, 285s' });
    expect(jobSummary('scan.root', 'done', p)).toBe('Checked 241,516 files: no changes.');
    const q = parseProgress({ message: 'full: 10 seen, 2 added, 1 changed, 3 missing, 0/4 dirs skipped, 5s' });
    expect(jobSummary('scan.root', 'done', q)).toBe('Checked 10 files: 2 added, 1 changed, 3 missing.');
  });

  it('says how a finished identification sweep went, with its numbers', () => {
    const p = parseProgress({ done: 27149, total: 27153, message: '20949 of 27153 albums identified (77.2%)' });
    expect(jobSummary('identify.sweep', 'done', p)).toBe('Went through 27,153 albums; 20,949 identified.');
    expect(jobSummary('identify.sweep', 'running', parseProgress({ done: 5, total: 10 }))).toBe('5 of 10 albums checked.');
  });

  it('reads routine check messages', () => {
    expect(jobSummary('enrich.sweep', 'done', parseProgress({ message: 'enqueued 0 releases for Discogs bridging' }))).toBe('Nothing new to look up.');
    expect(jobSummary('collection.sync', 'done', parseProgress({ message: 'Mapped 0/0' }))).toBe('No new items in your collection.');
    expect(jobSummary('gaps.recompute', 'done', parseProgress({ message: 'incomplete_album:3546 duplicate:1052 missing_album:6 quality:27112' })))
      .toBe('Open: 3,546 incomplete albums, 1,052 duplicates, 6 missing albums.');
  });

  it('returns null rather than a raw message it cannot read', () => {
    expect(jobSummary('some.future.job', 'done', parseProgress({ message: 'k=v internal' }))).toBeNull();
  });
});

describe('retryRequest', () => {
  it('rebuilds a folder scan from its subject', () => {
    expect(retryRequest({ type: 'scan.root', subjectType: 'scan_root', subjectId: ROOT }, LIB))
      .toEqual({ queue: 'scan.root', data: { scanRootId: ROOT, mode: 'full' }, singletonKey: `scan:${ROOT}` });
  });
  it('rebuilds library-wide checks', () => {
    expect(retryRequest({ type: 'collection.sync', subjectType: null, subjectId: null }, LIB)?.data).toEqual({ libraryId: LIB });
  });
  it('refuses work it cannot rebuild', () => {
    expect(retryRequest({ type: 'scan.dir', subjectType: 'scan_root', subjectId: ROOT }, LIB)).toBeNull();
    expect(retryRequest({ type: 'scan.root', subjectType: null, subjectId: null }, LIB)).toBeNull();
    expect(retryRequest({ type: 'worker.heartbeat', subjectType: null, subjectId: null }, LIB)).toBeNull();
  });
});

describe('deriveJobViews', () => {
  it('never returns undefined for any field', () => {
    const [v] = views([row({ type: 'mystery', subjectType: null, subjectId: null, progress: null, startedAt: null, finishedAt: null })]);
    expect(v).not.toBeNull();
    for (const [k, value] of Object.entries(v!)) expect(value, k).not.toBeUndefined();
    expect(v!.at).toBe(v!.createdAt);
  });

  it('shows an unresolved failure with its error and a retry', () => {
    const [v] = views([row({ state: 'failed', error: 'walk failed: disk gone', startedAt: h(3), finishedAt: h(2) })]);
    expect(v).toMatchObject({ status: 'failed', error: 'walk failed: disk gone', retryable: true, resolvedAt: null, retrying: false });
  });

  it('marks a failure a later run finished as resolved, without a retry', () => {
    const [done, failed] = views([
      row({ state: 'completed', startedAt: h(1), finishedAt: h(0.5) }),
      row({ state: 'failed', error: 'boom', startedAt: h(5), finishedAt: h(4) }),
    ]);
    expect(done!.status).toBe('done');
    expect(failed).toMatchObject({ status: 'failed', retryable: false, resolvedAt: h(0.5), summary: 'A later run finished this work.', routine: true });
  });

  it('only resolves failures of the same work (same folder)', () => {
    const [, failed] = views([
      row({ state: 'completed', subjectId: '11111111-1111-4111-8111-111111111111', finishedAt: h(0.5) }),
      row({ state: 'failed', error: 'boom', finishedAt: h(4) }),
    ]);
    expect(failed).toMatchObject({ resolvedAt: null, retryable: true });
  });

  it('treats a failure whose work is running again as being retried', () => {
    const [running, failed] = views([
      row({ state: 'running', startedAt: h(0.1), progress: { done: 10, total: 0 } }),
      row({ state: 'failed', error: 'boom', finishedAt: h(4) }),
    ]);
    expect(running!.status).toBe('running');
    expect(failed).toMatchObject({ retrying: true, retryable: false, summary: 'Running again now.', routine: false });
  });

  it('only lets the newest attempt at a piece of work need the owner', () => {
    const [newer, older] = views([
      row({ type: 'collection.sync', subjectType: null, subjectId: null, state: 'failed', error: 'token rejected', finishedAt: h(14) }),
      row({ type: 'collection.sync', subjectType: null, subjectId: null, state: 'running', startedAt: h(60) }),
    ]);
    expect(newer).toMatchObject({ status: 'failed', needsAttention: true, retryable: true });
    expect(older).toMatchObject({ status: 'interrupted', needsAttention: false, retryable: false, resolvedAt: null, retrying: false,
      summary: 'Tried again later; see the newer attempt.' });
  });

  it('says "retrying" only for the attempt the running retry follows', () => {
    const sync = { type: 'collection.sync', subjectType: null, subjectId: null } as const;
    const [waiting, failed, older] = views([
      row({ ...sync, state: 'created', createdAt: h(0.01) }),
      row({ ...sync, state: 'failed', error: 'token rejected', finishedAt: h(14) }),
      row({ ...sync, state: 'running', startedAt: h(60) }),
    ]);
    expect(waiting!.status).toBe('waiting');
    expect(failed).toMatchObject({ retrying: true, needsAttention: false });
    expect(older).toMatchObject({ retrying: false, needsAttention: false, summary: 'Tried again later; see the newer attempt.' });
  });

  it('calls a running row interrupted once a later run exists or it is too old', () => {
    const [, superseded] = views([row({ state: 'completed', finishedAt: h(1) }), row({ state: 'running', startedAt: h(2) })]);
    expect(superseded!.status).toBe('interrupted');
    const [old] = views([row({ type: 'collection.sync', subjectType: null, subjectId: null, state: 'running', startedAt: h(30) })]);
    expect(old).toMatchObject({ status: 'interrupted', retryable: true });
  });

  it('keeps a days-long identification sweep running', () => {
    const [v] = views([row({ type: 'identify.sweep', subjectType: null, subjectId: null, state: 'running', startedAt: h(72), progress: { done: 5, total: 10 } })]);
    expect(v).toMatchObject({ status: 'running', progress: { done: 5, total: 10 } });
  });

  it('drops a scan request the worker merged into a later run', () => {
    const out = views([row({ state: 'running', startedAt: h(0.1) }), row({ state: 'created', createdAt: h(0.2) })]);
    expect(out[1]).toBeNull();
  });

  it('shows a fresh scan request as waiting, and a forgotten one as never started', () => {
    expect(views([row({ state: 'created', createdAt: h(0.1) })])[0]!.status).toBe('waiting');
    expect(views([row({ state: 'created', createdAt: h(20) })])[0]).toMatchObject({ status: 'interrupted', summary: 'Never started.' });
  });

  it('flags finished scheduled checks as routine, but never their failures', () => {
    const [ok, bad] = views([
      row({ type: 'enrich.sweep', subjectType: null, subjectId: null, state: 'completed', progress: { message: 'enqueued 0 releases for Discogs bridging' } }),
      row({ type: 'gaps.recompute', subjectType: null, subjectId: null, state: 'failed', error: 'x' }),
    ]);
    expect(ok!.routine).toBe(true);
    expect(bad!.routine).toBe(false);
  });

  it('folds away scheduled quick scans that found nothing, but not scans with changes or full scans', () => {
    const msg = (m: string) => ({ progress: { done: 5, total: 5, message: m } });
    const [quiet, changed, full] = views([
      row({ ...msg('quick: 241516 seen, 0 added, 0 changed, 0 missing, 72502/72502 dirs skipped, 285s') }),
      row({ ...msg('quick: 241516 seen, 3 added, 0 changed, 0 missing, 72500/72502 dirs skipped, 290s'), subjectId: '44444444-4444-4444-8444-444444444444' }),
      row({ ...msg('full: 241516 seen, 0 added, 0 changed, 0 missing, 0/72502 dirs skipped, 900s'), subjectId: '55555555-5555-4555-8555-555555555555' }),
    ]);
    expect([quiet!.routine, changed!.routine, full!.routine]).toEqual([true, false, false]);
  });
});

describe('summarizeJobs', () => {
  it('counts what is running, waiting and still needs the owner', () => {
    const out = views([
      row({ state: 'created', createdAt: h(0.05), subjectId: '22222222-2222-4222-8222-222222222222' }),
      row({ state: 'running', startedAt: h(0.1), subjectId: '33333333-3333-4333-8333-333333333333' }),
      row({ state: 'completed', finishedAt: h(1) }),
      row({ state: 'failed', error: 'old, fixed later', finishedAt: h(3) }),
      row({ type: 'collection.sync', subjectType: null, subjectId: null, state: 'failed', error: 'Discogs said no', finishedAt: h(2) }),
    ]).filter((v): v is JobView => v !== null);
    expect(summarizeJobs(out, 4)).toEqual({ running: 1, waiting: 1, needsAttention: 1, routineHidden: 4, lastFinishedAt: h(1) });
  });
});
