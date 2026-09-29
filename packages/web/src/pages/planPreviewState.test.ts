import { describe, expect, it } from 'vitest';
import type { TagPlanPreviewJob } from '@liner/shared';
import { canPreview, derivePreviewState, progressSignature, type PreviewInput } from './planPreviewState';

const base: PreviewInput = {
  job: undefined,
  requestedJobId: undefined,
  requestPending: false,
  requested: false,
  timedOut: false,
  runningStale: false,
  previewed: false,
};
const job = (over: Partial<TagPlanPreviewJob>): TagPlanPreviewJob => ({
  jobId: 'j1', state: 'queued', queuedAt: '2026-09-28T16:33:07.000Z', ...over,
});

describe('derivePreviewState', () => {
  it('offers a first preview when nothing has been asked', () => {
    expect(derivePreviewState(base)).toMatchObject({ failed: false, stalled: null, busy: false, buttonLabel: 'Run preview' });
  });

  it('is busy while the request is in flight, even over an old failed run', () => {
    const s = derivePreviewState({ ...base, requestPending: true, requested: true, job: job({ state: 'failed', error: 'boom' }) });
    expect(s).toMatchObject({ failed: false, busy: true, buttonLabel: 'Previewing…' });
  });

  it('shows a queued job as busy until the wait runs out, then as queued and retryable', () => {
    const queued = { ...base, requested: true, requestedJobId: 'j1', job: job({ state: 'queued' }) };
    expect(derivePreviewState(queued)).toMatchObject({ busy: true, stalled: null });
    expect(derivePreviewState({ ...queued, timedOut: true })).toMatchObject({ busy: false, stalled: 'queued', buttonLabel: 'Retry preview' });
  });

  it('does not call a running job that keeps reporting progress timed out', () => {
    const s = derivePreviewState({ ...base, requested: true, timedOut: true, requestedJobId: 'j1', job: job({ state: 'running', done: 3, total: 15 }) });
    expect(s).toMatchObject({ busy: true, stalled: null, buttonLabel: 'Previewing…' });
  });

  it('warns when a running job stops reporting progress', () => {
    const s = derivePreviewState({ ...base, runningStale: true, job: job({ state: 'running', message: 'Comparing tags: 4 of 15 files' }) });
    expect(s).toMatchObject({ busy: false, stalled: 'no-progress', buttonLabel: 'Retry preview' });
  });

  it('reports a failed run with its error and offers a retry', () => {
    const s = derivePreviewState({ ...base, job: job({ state: 'failed', error: 'Tag plan p not found' }) });
    expect(s.failed).toBe(true);
    expect(s.current?.error).toBe('Tag plan p not found');
    expect(s.buttonLabel).toBe('Retry preview');
  });

  it('ignores an older failed run once a new request is out, until the new job shows up', () => {
    const stale = { ...base, requested: true, requestedJobId: 'j2', job: job({ jobId: 'j1', state: 'failed', error: 'old' }) };
    expect(derivePreviewState(stale)).toMatchObject({ current: undefined, failed: false, busy: true });
    // The page's wait runs out and the API still only knows the old run.
    expect(derivePreviewState({ ...stale, timedOut: true })).toMatchObject({ failed: false, stalled: 'no-report', busy: false });
    // The new job arrives and runs.
    expect(derivePreviewState({ ...stale, timedOut: true, job: job({ jobId: 'j2', state: 'running' }) }))
      .toMatchObject({ failed: false, stalled: null, busy: true });
  });

  it('says the request never reported back when no job ever appeared', () => {
    const s = derivePreviewState({ ...base, requested: true, timedOut: true });
    expect(s).toMatchObject({ stalled: 'no-report', busy: false, buttonLabel: 'Retry preview' });
  });

  it('offers a re-run on a plan that already has results', () => {
    expect(derivePreviewState({ ...base, previewed: true }).buttonLabel).toBe('Re-run preview');
  });
});

describe('canPreview', () => {
  it('offers a preview only where the API accepts one', () => {
    expect(canPreview('draft')).toBe(true);
    expect(canPreview('previewed')).toBe(true);
    for (const s of ['applying', 'applied', 'paused', 'partially_failed', 'cancelled', 'reverted', undefined]) {
      expect(canPreview(s)).toBe(false);
    }
  });
});

describe('progressSignature', () => {
  it('changes when the worker reports new progress and not otherwise', () => {
    const a = job({ state: 'running', done: 1, total: 15, message: 'Comparing tags: 1 of 15 files' });
    expect(progressSignature(a)).toBe(progressSignature({ ...a }));
    expect(progressSignature(a)).not.toBe(progressSignature({ ...a, done: 2, message: 'Comparing tags: 2 of 15 files' }));
    expect(progressSignature(undefined)).toBe('');
  });
});
