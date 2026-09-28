/**
 * latestPreviewJob: the plan page's view of a draft's preview job. Raw rows
 * arrive with timestamps (and jsonb) as strings on the shared client, so the
 * mapping must accept both.
 */
import { describe, it, expect } from 'vitest';
import { latestPreviewJob } from './tagPlans.js';

const dbReturning = (rows: unknown[]) => ({ execute: async () => rows }) as never;

describe('latestPreviewJob', () => {
  it('is undefined when the plan never had a preview job', async () => {
    expect(await latestPreviewJob(dbReturning([]), 'p')).toBeUndefined();
  });

  it('maps a running job with worker progress, string timestamps and string jsonb', async () => {
    const job = await latestPreviewJob(dbReturning([{
      job_id: 'b1', boss_state: 'active',
      created_on: '2026-09-28 16:33:07.475+00', started_on: '2026-09-28T16:33:08.714Z', completed_on: null,
      run_id: '0b6d7f39-4c11-4d7e-9a53-0d6f0f8f7c11',
      progress: JSON.stringify({ done: 4, total: 15, message: 'Comparing tags: 4 of 15 files' }), error: null,
    }]), 'p');
    expect(job).toEqual({
      jobId: 'b1', state: 'running',
      queuedAt: '2026-09-28T16:33:07.475Z', startedAt: '2026-09-28T16:33:08.714Z',
      jobRunId: '0b6d7f39-4c11-4d7e-9a53-0d6f0f8f7c11',
      message: 'Comparing tags: 4 of 15 files', done: 4, total: 15,
    });
  });

  it('reports a job the worker has not started as queued, without inventing progress', async () => {
    const job = await latestPreviewJob(dbReturning([{
      job_id: 'b2', boss_state: 'created', created_on: new Date('2026-09-28T16:33:07Z'), started_on: null, completed_on: null,
      run_id: null, progress: null, error: null,
    }]), 'p');
    expect(job).toEqual({ jobId: 'b2', state: 'queued', queuedAt: '2026-09-28T16:33:07.000Z' });
  });

  it('carries the error of a failed run', async () => {
    const job = await latestPreviewJob(dbReturning([{
      job_id: 'b3', boss_state: 'failed', created_on: '2026-09-28T16:33:07Z', started_on: '2026-09-28T16:33:08Z', completed_on: '2026-09-28T16:33:09Z',
      run_id: null, progress: { done: 0, total: 0 }, error: 'Tag plan p not found',
    }]), 'p');
    expect(job).toMatchObject({ state: 'failed', error: 'Tag plan p not found', done: 0 });
    expect(job).not.toHaveProperty('total');
  });
});
