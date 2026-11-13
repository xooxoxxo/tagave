/**
 * Library care refreshes after an operation that changed albums (rr85):
 * the lists and counts, the task list, the album pages and the grid's
 * problem filters, and again when the worker's quality check ends.
 */
import { describe, expect, it, vi } from 'vitest';
import { invalidateAlbumCare } from './useGaps';
import { isCareCheckDone } from './useIdentify';

describe('invalidateAlbumCare', () => {
  it('refreshes Library care, the nav counts, tasks, album pages and the grid', async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    await invalidateAlbumCare({ invalidateQueries } as never);
    const keys = invalidateQueries.mock.calls.map((c) => (c as unknown as [{ queryKey: string[] }])[0].queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['gaps', 'tasks', 'album', 'albums', 'album-facets']));
  });
});

describe('isCareCheckDone', () => {
  it('is the end of a gaps.recompute, not its progress nor another job', () => {
    expect(isCareCheckDone('job.completed', { type: 'job.completed', jobType: 'gaps.recompute' })).toBe(true);
    expect(isCareCheckDone('job.progress', { type: 'job.progress', jobType: 'gaps.recompute' })).toBe(false);
    expect(isCareCheckDone('job.completed', { type: 'job.completed', jobType: 'scan.dir' })).toBe(false);
  });
});
